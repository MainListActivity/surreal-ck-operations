/**
 * Devin Cloud 通道驱动：`devin --cloud -p --prompt-file` 同步执行并打印最终答复（实测 ~12s 级）。
 * CLI 不暴露云端会话 ID（devin list 只列本地会话），通道自己生成逻辑会话 ID；
 * 续轮开新云端会话，prompt 里说明在同一分支/PR 上继续。
 * 完成后 git fetch + --ff-only 快进本地工作树；非快进报错回合，绝不 reset。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBranchOnOrigin, fetchAndFastForward, type RepoInfo } from './repo.ts';
import type { LaneDeps, LaneInput } from './lane.ts';

interface Ctx {
  input: LaneInput; deps: LaneDeps; repo: RepoInfo;
  material: { task: string; findings?: string; review: boolean; title: string };
  prompt: string; state: { taskId?: string };
  digest: string; deadline: number;
}

export async function driveDevin(ctx: Ctx): Promise<{ kind: 'done' | 'blocked' | 'error'; text: string }> {
  const { input, deps, repo, material, prompt } = ctx;
  const continuing = Boolean(ctx.state.taskId) || Boolean(input.resumeId);
  try { await ensureBranchOnOrigin(deps.exec, input.cwd, repo.branch); }
  catch (error) { return { kind: 'error', text: (error as Error).message }; }

  const dir = mkdtempSync(join(tmpdir(), 'sck-devin-'));
  const file = join(dir, 'prompt.txt');
  const followUp = continuing && !material.review
    ? '\n这是同一任务的后续轮次：该分支上可能已有你的云端会话推送过改动并开过 PR，请先拉取远端分支现状，在既有 PR 上继续更新，不要另开重复 PR。'
    : '';
  writeFileSync(file, `${prompt}${followUp}\n`);
  deps.progress('已提交 Devin Cloud 会话（同步等待）');
  const timeoutMs = Math.max(60_000, ctx.deadline - deps.now());
  const r = await deps.exec('devin', ['--cloud', '-p', '--prompt-file', file], { cwd: input.cwd, timeoutMs });
  rmSync(dir, { recursive: true, force: true });
  if (r.code !== 0)
    return { kind: 'error', text: `Devin Cloud 会话失败：${(r.stderr || r.stdout).trim().slice(0, 500)}` };
  const text = r.stdout.trim();
  if (!text) return { kind: 'error', text: 'Devin Cloud 会话结束但没有答复文本' };

  if (material.review) return { kind: 'done', text };

  const pr = /^PR:\s*(\S+)/m.exec(text)?.[1];
  const sha = /^SHA:\s*([0-9a-f]{7,40})/im.exec(text)?.[1];
  try {
    const head = await fetchAndFastForward(deps.exec, input.cwd, repo.branch);
    if (!pr) return { kind: 'blocked', text: `Devin 已把改动推上分支（本地已快进至 ${head.slice(0, 12)}），但答复里没有 PR 行：${text.slice(0, 300)}` };
    // 公司收尾以远端分支实际 HEAD 为准：Devin 声明的 SHA 不一致时改写并注明。
    if (!sha) return { kind: 'done', text: `${text}\nSHA: ${head}` };
    if (head.startsWith(sha)) return { kind: 'done', text };
    return { kind: 'done',
      text: `${text.replace(/^SHA:\s*\S+/im, `SHA: ${head}`)}\n（Devin 声明的 SHA ${sha} 与远端分支实际 HEAD 不一致，以实际 HEAD 为准）` };
  } catch (error) {
    if (!pr && !sha) return { kind: 'blocked', text: `Devin 未在分支 ${repo.branch} 上留下可快取的改动：${text.slice(0, 300)}` };
    return { kind: 'error', text: (error as Error).message };
  }
}
