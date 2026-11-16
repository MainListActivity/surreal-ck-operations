/**
 * Devin Cloud 通道驱动：`devin --cloud -p --prompt-file` 同步执行并打印最终答复（实测 ~12s 级）。
 * CLI 不暴露云端会话 ID（devin list 只列本地会话），通道自己生成逻辑会话 ID；
 * 续轮开新云端会话，prompt 里说明在同一分支/PR 上继续。
 * 完成后 git fetch + --ff-only 快进本地工作树；非快进报错回合，绝不 reset。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUOTA_ERROR } from '../../dispatcher/quota-failure.ts';
import { ensureBranchOnOrigin, fetchAndFastForward, type RepoInfo } from './repo.ts';
import type { LaneDeps, LaneInput } from './lane.ts';

/** Devin 云模式的免费模型。公司派工只允许它（老板 2026-11-15 定），不是可覆盖的默认值。 */
export const DEVIN_CLOUD_MODEL = 'free';

/**
 * 云端会话的模型：缺省或字面 `free` 才放行，其它值（含空白、空串、null）一律抛错。
 * 配置校验与执行入口共用这一处：入口即使绕过配置校验也不会发出非 free 的云端会话，也不回退到账号默认或其它模型。
 */
export function devinCloudModel(configured: unknown): typeof DEVIN_CLOUD_MODEL {
  if (configured === undefined || configured === DEVIN_CLOUD_MODEL) return DEVIN_CLOUD_MODEL;
  throw new Error(`lanes.devin-cloud.model 只能是 "${DEVIN_CLOUD_MODEL}"（云端会话只用免费模型），收到 ${JSON.stringify(configured)}`);
}

/**
 * 供应商确定性拒绝这次请求：模型名不被识别，或账号无权使用它。同一请求再发一次结果不变，
 * 所以不能当会话异常处理（那会退役员工、重派任务，每次都撞同一个错误）。额度类报错不算，仍走 quota-failure。
 */
const DETERMINISTIC_REFUSAL = /unknown model|model\b[^\n]{0,60}?\b(?:not (?:found|supported)|unsupported)|not entitled|permission denied|no permission|insufficient permissions?|access denied|unauthori[sz]ed|forbidden|\b40[13]\b/i;
export function devinDeterministicRefusal(text: string): boolean {
  return DETERMINISTIC_REFUSAL.test(text) && !QUOTA_ERROR.test(text);
}

interface Ctx {
  input: LaneInput; deps: LaneDeps; repo: RepoInfo;
  material: { task: string; findings?: string; review: boolean; title: string };
  prompt: string; state: { taskId?: string };
  digest: string; deadline: number;
}

export async function driveDevin(ctx: Ctx): Promise<{ kind: 'done' | 'blocked' | 'error'; text: string; vendorTerminal?: boolean }> {
  const { input, deps, repo, material, prompt } = ctx;
  // 执行入口的硬约束：在推送分支、发会话之前校验，非 free 直接按错误回合收尾。
  let model: typeof DEVIN_CLOUD_MODEL;
  try { model = devinCloudModel(input.config.model); }
  catch (error) { return { kind: 'error', text: (error as Error).message }; }
  const continuing = Boolean(ctx.state.taskId) || Boolean(input.resumeId);
  try { await ensureBranchOnOrigin(deps.exec, input.cwd, repo.branch); }
  catch (error) { return { kind: 'error', text: (error as Error).message }; }

  const dir = mkdtempSync(join(tmpdir(), 'sck-devin-'));
  const file = join(dir, 'prompt.txt');
  const followUp = continuing && !material.review
    ? '\n这是同一任务的后续轮次：该分支上可能已有你的云端会话推送过改动并开过 PR，请先拉取远端分支现状，在既有 PR 上继续更新，不要另开重复 PR。'
    : '';
  writeFileSync(file, `${prompt}${followUp}\n`);
  // 尝试与受理分开报：启动调用本身不是受理证据，只有拿到云端答复（退出码 0）才算已受理。
  deps.progress('尝试提交 Devin Cloud 会话（同步等待）', 'attempt');
  const timeoutMs = Math.max(60_000, ctx.deadline - deps.now());
  // 公司派工只用云模式的 free 模型（老板 2026-11-15 定）：不传模型的话云端会按账号默认模型计费。
  const r = await deps.exec('devin', ['--cloud', '--model', model, '-p', '--prompt-file', file], { cwd: input.cwd, timeoutMs })
    .finally(() => rmSync(dir, { recursive: true, force: true }));
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 500);
    // 模型或账号权限被供应商确定性拒绝：重派结果不变，按受阻收尾等配置修复（不是会话异常，不退役员工）。
    if (devinDeterministicRefusal(`${r.stderr}\n${r.stdout}`)) {
      deps.progress('Devin Cloud 拒绝本次会话（模型或账号权限不符），等待配置修复', 'failed');
      return { kind: 'blocked', text: `Devin Cloud 拒绝了本次会话，模型或账号权限不符：${detail}\n这类错误重试不会好转：执行端不会自动重派，也不会换用其它模型或账号默认模型，也不计为额度不足。修复 Devin 侧的模型名或账号权限后再派工。` };
    }
    deps.progress(`Devin Cloud 会话未取得受理证据（退出码 ${r.code}）`, 'failed');
    return { kind: 'error', text: `Devin Cloud 会话失败：${detail}` };
  }
  const text = r.stdout.trim();
  if (!text) {
    deps.progress('Devin Cloud 没有返回答复，未取得受理证据', 'failed');
    return { kind: 'error', text: 'Devin Cloud 会话结束但没有答复文本' };
  }
  deps.progress('Devin Cloud 已受理并返回答复', 'accepted');

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
