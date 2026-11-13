/**
 * Codex Cloud 通道驱动：codex cloud exec 提交 → codex cloud status 轮询 →
 * codex cloud apply 应用到本地工作树 → git 提交/推送 → gh 建 PR。
 * 实测格式（2026-11 probe）：exec 输出一行任务 URL；status 首行 `[STATUS] 标题`，
 * `no diff` 表示无改动；list --json 输出 {tasks:[{id,url,title,status,summary}]}。
 * Codex Cloud 的最终消息 CLI 取不到：复核结论改由供应商写入仓库 .sck/review.md，
 * 从 codex cloud diff 的补丁行里提取。
 */
import { ensureBranchOnOrigin, ensurePullRequest, type RepoInfo } from './repo.ts';
import type { LaneDeps, LaneInput } from './lane.ts';
import { recordInflight, writeLaneState } from './state.ts';

interface Ctx {
  input: LaneInput; deps: LaneDeps; repo: RepoInfo;
  material: { task: string; findings?: string; review: boolean; title: string };
  prompt: string; state: { taskId?: string; taskUrl?: string; sessionId: string; digest?: string; branch?: string; submittedAt?: number };
  digest: string; deadline: number;
}

const TERMINAL: Record<string, 'done' | 'failed'> = { READY: 'done', APPLIED: 'done', ERROR: 'failed', FAILED: 'failed' };
const TASK_ID = /(task_[A-Za-z0-9_-]+)/;
const REVIEW_FILE = '.sck/review.md';

async function statusOf(ctx: Ctx, taskId: string): Promise<{ code: 'pending' | 'done' | 'failed'; head: string; vendor: boolean }> {
  const { deps, input } = ctx;
  const r = await deps.exec('codex', ['cloud', 'status', taskId], { cwd: input.cwd });
  const head = r.stdout.split('\n').find(l => l.trim()) ?? '';
  const mark = /^\[([A-Z_]+)\]/.exec(head)?.[1] ?? '';
  // 状态标记是权威：CLI 在任务未结束时也以退出码 1 返回（实测 [PENDING] → exit 1），
  // 只有解析不到标记时退出码才作为失败依据。
  if (mark) return { code: TERMINAL[mark] ?? 'pending', head, vendor: TERMINAL[mark] === 'failed' };
  if (r.code !== 0) return { code: 'failed', head: r.stderr.trim() || head, vendor: false };
  return { code: 'pending', head, vendor: false };
}

/** 统一补丁里 diff --git 行给出的仓库相对路径集合（a、b 两侧都收，覆盖改名/删除；/dev/null 忽略）。 */
export function diffPaths(patch: string): Set<string> {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] !== 'dev/null') paths.add(m[1]!);
    if (m[2] !== 'dev/null') paths.add(m[2]!);
  }
  return paths;
}

/** 从 `codex cloud diff` 的统一补丁提取 .sck/review.md 的新增行（复核轮的供应商结论）。 */
async function reviewFromDiff(ctx: Ctx, taskId: string): Promise<string | undefined> {
  const r = await ctx.deps.exec('codex', ['cloud', 'diff', taskId], { cwd: ctx.input.cwd });
  if (r.code !== 0) return undefined;
  const lines = r.stdout.split('\n');
  const start = lines.findIndex(l => l.startsWith('+++ b/') && l.slice(6).trim() === REVIEW_FILE);
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('--- ')) break;
    if (line.startsWith('+')) body.push(line.slice(1));
  }
  const text = body.join('\n').trim();
  return text || undefined;
}

export async function driveCodex(ctx: Ctx): Promise<{ kind: 'done' | 'blocked' | 'error'; text: string; vendorTerminal?: boolean }> {
  const { input, deps, repo, material, prompt, state } = ctx;
  const env = input.config.environments?.[repo.slug] ?? repo.repo;
  const save = () => {
    writeLaneState(input.commDir, { ...state, submittedAt: state.submittedAt ?? deps.now() });
    recordInflight(input.stateRoot, input.provider, ctx.digest, state);
  };

  let taskId = state.taskId;
  let taskUrl = state.taskUrl;
  if (!taskId) {
    await ensureBranchOnOrigin(deps.exec, input.cwd, repo.branch);
    const reviewHint = material.review ? `\n复核结论请同时写入仓库文件 ${REVIEW_FILE}（最终消息首行也保持「复核结论：…」）。` : '';
    const r = await deps.exec('codex', ['cloud', 'exec', '--env', env, '--branch', repo.branch, `${prompt}${reviewHint}`], { cwd: input.cwd });
    const found = TASK_ID.exec(r.stdout);
    if (r.code !== 0 || !found)
      return { kind: 'error', text: `Codex Cloud 提交失败：${(r.stderr || r.stdout).trim().slice(0, 500)}` };
    taskId = found[1]!;
    taskUrl = (r.stdout.match(/https:\/\/\S+/) ?? [`https://chatgpt.com/codex/tasks/${taskId}`])[0];
    state.taskId = taskId; state.taskUrl = taskUrl; save();
    deps.progress(`已提交 Codex Cloud 任务 ${taskId}`);
  } else deps.progress(`重连 Codex Cloud 任务 ${taskId}`);

  let head = '', terminal: 'done' | 'failed' = 'done', vendorTerminal = false;
  for (;;) {
    const s = await statusOf(ctx, taskId);
    head = s.head;
    if (s.code !== 'pending') { terminal = s.code; vendorTerminal = s.vendor; break; }
    if (deps.now() > ctx.deadline)
      return { kind: 'error', text: `Codex Cloud 任务超时仍未结束（${taskUrl}）；它可能仍在运行，请人工核对后再重试。` };
    deps.progress(`云端运行中：${head || '等待任务状态'}`);
    await deps.sleep(input.config.pollMs ?? 25_000);
  }
  if (terminal === 'failed')
    return { kind: 'error', vendorTerminal, text: `Codex Cloud 任务失败（${taskUrl}）：${head || '无状态输出'}` };

  if (material.review) {
    const text = await reviewFromDiff(ctx, taskId);
    if (!text) return { kind: 'error', text: `Codex Cloud 复核任务结束但取不到 ${REVIEW_FILE} 结论（${taskUrl}）` };
    return { kind: 'done', text };
  }

  const diff = await deps.exec('codex', ['cloud', 'diff', taskId], { cwd: input.cwd });
  const hasDiff = diff.code === 0 && diff.stdout.trim().length > 0;
  if (!hasDiff) return { kind: 'blocked', text: `云端任务未产生代码改动（${taskUrl}）。${head}` };

  const apply = await deps.exec('codex', ['cloud', 'apply', taskId], { cwd: input.cwd });
  if (apply.code !== 0) return { kind: 'error', text: `应用云端补丁失败：${apply.stderr.trim().slice(0, 400)}` };
  const must = async (args: string[], what: string) => {
    const r = await deps.exec('git', args, { cwd: input.cwd });
    if (r.code !== 0) throw new Error(`${what}失败：${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    return r.stdout.trim();
  };
  try {
    // 只暂存云端补丁覆盖的路径：工作树里可能有无关文件（如 codex CLI 自己写的 error.log），不能一起提交。
    const paths = [...diffPaths(diff.stdout)];
    if (paths.length) await must(['add', '-A', '--', ...paths], '暂存云端改动');
    const staged = (await deps.exec('git', ['diff', '--cached', '--name-only'], { cwd: input.cwd })).stdout
      .split('\n').map(l => l.trim()).filter(Boolean);
    const wanted = new Set(paths);
    const extra = staged.filter(p => !wanted.has(p));
    let note = '';
    if (extra.length) {
      await deps.exec('git', ['reset', '-q', '--', ...extra], { cwd: input.cwd });
      note = `（另有 ${extra.length} 个与云端补丁无关的暂存改动已取消暂存，未动文件）`;
    }
    const kept = staged.filter(p => wanted.has(p));
    if (!kept.length) return { kind: 'blocked', text: `云端补丁应用后没有任何改动（${taskUrl}）。` };
    await must(['commit', '-m', `${material.title} (Codex Cloud ${taskId})`], '提交云端改动');
    await must(['push', 'origin', `HEAD:${repo.branch}`], '推送云端改动');
    const sha = await must(['rev-parse', 'HEAD'], '读取提交');
    const pr = await ensurePullRequest(deps.exec, input.cwd, repo, material.title,
      `云端任务：${taskUrl}\n\n由 ${input.provider} 员工通道完成。`);
    return { kind: 'done', text: `云端任务完成：${head}\n任务：${taskUrl}\nPR: ${pr}\nSHA: ${sha}${note ? `\n${note}` : ''}` };
  } catch (error) { return { kind: 'error', text: (error as Error).message }; }
}
