/**
 * Devin Cloud 通道驱动：经 ego-browser 在 app.devin.ai 网页里跑云端会话。
 * CLI 的 `devin --cloud --model free` 在本机版本（3000.12.57）拒绝 free 为 Unknown model，
 * 网页才是公司免费档位的真实入口：每次发送前页面核验 Capability 选中 Free
 * （"Free (powered by SWE-2)"）且读到 "N/M in use" 席位有余，满额等待绝不改选付费档。
 * 会话地址记在 state.vendorSession/taskUrl：同任务续轮、返工、复核都回原会话发跟进消息，
 * 不新建会话；超时或已按下发送但回执丢失时，先回会话列表/原会话按本轮标记核对是否已受理，
 * 确认未受理才允许再发。完成后 git fetch + --ff-only 快进本地工作树；非快进报错回合，绝不 reset。
 */
import { ensureBranchOnOrigin, fetchAndFastForward, type RepoInfo } from './repo.ts';
import { recordInflight, writeLaneState, type LaneState } from './state.ts';
import { devinFollowScript, devinRecoverScript, devinSendScript, devinSessionScript, DEVIN_HOME, DEVIN_SESSION_RE } from './devin-web.ts';
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

interface Ctx {
  input: LaneInput; deps: LaneDeps; repo: RepoInfo;
  material: { task: string; findings?: string; review: boolean; title: string };
  prompt: string; state: LaneState;
  digest: string; deadline: number;
}

interface VendorOutcome {
  kind: 'done' | 'blocked' | 'error';
  text: string;
  vendorTerminal?: boolean;
}

type Browse = NonNullable<LaneDeps['browse']>;

/** 空闲会话里连续几轮看不到本轮标记，才认定消息没有被受理（转录可能还在渲染）。 */
const MARKER_MISS_LIMIT = 3;
/** 「已按下发送但地址丢失」时在会话列表里核对受理的有界次数。 */
const RECOVERY_LIMIT = 4;

export async function driveDevin(ctx: Ctx): Promise<VendorOutcome> {
  const { input, deps, repo, material, prompt, state } = ctx;
  const fail = (text: string): VendorOutcome => ({ kind: 'error', text });
  const blocked = (text: string): VendorOutcome => ({ kind: 'blocked', text });
  // 执行入口的硬约束：在推送分支、发会话之前校验，非 free 直接按错误回合收尾。
  try { devinCloudModel(input.config.model); }
  catch (error) { return fail((error as Error).message); }
  const browse: Browse | undefined = deps.browse;
  if (!browse) return fail('devin-cloud 经 Devin 网页入口执行，需要 ego-browser（lanes.devin-cloud.bin["ego-browser"] 或 ~/.local/bin/ego-browser）');
  try { await ensureBranchOnOrigin(deps.exec, input.cwd, repo.branch); }
  catch (error) { return fail((error as Error).message); }

  const pollMs = input.config.pollMs ?? 25_000;
  const maxMinutes = input.config.maxMinutes ?? 180;
  const home = input.env.SCK_DEVIN_HOME?.trim() || DEVIN_HOME;
  // 本轮标记由 prompt 摘要决定：同一轮重启/重连得到同一标记，新一轮换新标记。
  const marker = `SCK-${ctx.digest.slice(0, 10)}`;
  const continuing = Boolean(state.vendorSession) || Boolean(state.taskId) || Boolean(input.resumeId);
  const followUp = continuing && !material.review
    ? '\n这是同一任务的后续轮次：该分支上可能已有你的云端会话推送过改动并开过 PR，请先拉取远端分支现状，在既有 PR 上继续更新，不要另开重复 PR。'
    : '';
  const message = `[SCK-ROUND ${marker}]\n\n${prompt}${followUp}\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${marker}]」单独成行开头，随后是完整最终答复。\n`;

  const persist = () => {
    writeLaneState(input.commDir, state);
    recordInflight(input.stateRoot, input.provider, ctx.digest, state);
  };
  const loginFail = () => fail('app.devin.ai 未登录或登录已过期（需要老板在 ego-browser 里重新登录 Devin）');
  const over = () => deps.now() > ctx.deadline;

  // ---- 确定本轮会话地址的统一循环：
  // 同一摘要重连不重发；已按下发送但地址丢失时先在会话列表核对受理，确认未受理才允许重发；
  // 有可复用会话发跟进消息（不占新席位），新建会话前每次都在页面核验 Free 与席位，满额等待绝不改档。 ----
  const sessionOf = (value: unknown): string | undefined =>
    typeof value === 'string' && DEVIN_SESSION_RE.test(value) ? value.split('?')[0]!.split('#')[0] : undefined;
  let sessionUrl = state.taskId ? (sessionOf(state.taskUrl) ?? sessionOf(state.vendorSession)) : undefined;
  let recoverMisses = 0;
  for (;;) {
    if (!state.taskId) {
      const follow = sessionOf(state.vendorSession);
      const r = await browse(follow ? devinFollowScript(follow, marker, message) : devinSendScript(home, marker, message), 150_000);
      if (r?.code === 'login_required') return loginFail();
      if (r?.code === 'capability') return fail(`无法确认 Devin Cloud 选中 Free 档位，本轮未发出：${String(r.detail ?? '').slice(0, 300)}`);
      if (r?.code === 'quota_full') {
        if (over()) return blocked(`Devin Free 席位持续已满（${String(r.seats ?? '?/?')} in use），本轮未发出；席位空出后恢复本任务即可，不会另建重复会话`);
        deps.progress(`Devin Free 席位已满（${String(r.seats ?? '?/?')} in use），等待空位`);
        await deps.sleep(pollMs);
        continue;
      }
      if (r?.code === 'busy') {
        if (over()) return blocked('Devin 会话一直在处理上一轮，续轮消息没有发出；会话空闲后恢复本任务即可');
        deps.progress('Devin 会话正忙，等它空下来再发续轮消息');
        await deps.sleep(pollMs);
        continue;
      }
      const url = sessionOf(r?.url) ?? sessionOf(r?.recovered);
      if (r?.ok === true && url) {
        sessionUrl = url;
        state.taskId = marker; state.taskUrl = url; state.vendorSession = url; state.submittedAt = deps.now();
        persist();
        deps.progress(r.already || r.recovered ? `Devin Cloud 已有本轮消息（${marker}），继续等待` : `已发给 Devin Cloud（${marker}，Free 席位已核验）`);
        break;
      }
      if (r?.ok === true || r?.code === 'pressed' || r?.code === 'not_echoed') {
        // 已按下发送但没拿到会话地址/回显：记为本轮在途，接下来只做受理核对，不重发。
        sessionUrl ??= url;
        state.taskId = marker; state.submittedAt = deps.now();
        if (url) { state.taskUrl = url; state.vendorSession = url; }
        persist();
        deps.progress(`Devin Cloud 已按下发送但未确认回显（${marker}），转入受理核对`);
        continue;
      }
      // not_ready / 浏览器没起来 / 脚本没回结果：可重试（尚未按下发送）。
      if (over()) return fail(`Devin 网页在 ${maxMinutes} 分钟内一直没准备好或浏览器不可用，本轮未发出`);
      deps.progress('Devin 页面未就绪，稍后重试');
      await deps.sleep(pollMs);
      continue;
    }
    if (!sessionUrl) {
      const r = await browse(devinRecoverScript(home, marker), 150_000);
      if (r?.code === 'login_required') return loginFail();
      const found = sessionOf(r?.found);
      if (found) {
        sessionUrl = found;
        state.taskUrl = found; state.vendorSession = found;
        persist();
        deps.progress(`Devin Cloud 会话已核对受理：${found}`);
        break;
      }
      if (r?.ok === true && r.found === null && ++recoverMisses >= RECOVERY_LIMIT) {
        // 会话列表与最近几条会话里都没有本轮标记：上一次发送没有受理，允许重新发一次。
        deps.progress('Devin 会话列表核对未见本轮标记，按未受理处理，重新发送');
        delete state.taskId; delete state.taskUrl; delete state.submittedAt;
        recoverMisses = 0;
        persist();
        continue;
      }
      if (over())
        return fail(`Devin Cloud 已按下发送但会话地址与受理情况都无法确认（标记 ${marker}），未自动重发，请人工核对 app.devin.ai 会话列表`);
      await deps.sleep(pollMs);
      continue;
    }
    break;
  }
  if (!sessionUrl) return fail(`Devin Cloud 本轮未发出也没有可核对的会话（标记 ${marker}）`);
  // 轮询开始就把会话地址固化进可复用字段：本轮超时后，续轮仍在同一 Devin 会话里发跟进消息。
  if (state.vendorSession !== sessionUrl) { state.vendorSession = sessionUrl; persist(); }

  // ---- 阶段四：轮询会话页到终稿/提问/超时。终稿要求连续两次读数一致，防半截答复。 ----
  let settled: string | undefined, misses = 0;
  for (;;) {
    await deps.sleep(pollMs);
    const s = await browse(devinSessionScript(sessionUrl, marker), 90_000);
    if (s?.code === 'login_required') return loginFail();
    if (s?.ok === true) {
      const status = String(s.status ?? 'unknown');
      if (status === 'blocked') return blocked(`Devin 停下来等待人工输入，需要老板在会话里答复：${String(s.tail ?? '').slice(-400)}`);
      const answer = typeof s.done === 'string' && s.done.trim() ? s.done.trim() : undefined;
      if (status !== 'working' && s.markerSeen === true && answer) {
        if (settled === answer) return closeout(ctx, answer);
        settled = answer;
      } else settled = undefined;
      if (status !== 'working' && s.markerSeen !== true) {
        // 空闲会话里看不到本轮标记：消息没有受理。清掉在途标记后重发仍安全
        // （下一轮发送脚本会先核对标记），但连续核对过几次才动手，防转录未渲染。
        if (++misses >= MARKER_MISS_LIMIT) {
          delete state.taskId; delete state.taskUrl; delete state.submittedAt;
          persist();
          return driveDevin(ctx);
        }
      } else misses = 0;
      deps.progress(status === 'working' ? `Devin Cloud 工作中（${marker}）` : answer ? 'Devin Cloud 已给出终稿，确认中' : `Devin Cloud 空闲，等待终稿（${marker}）`);
    }
    if (over())
      return fail(`Devin Cloud 会话 ${sessionUrl} 超过配置时限仍未给出终稿（标记 ${marker}），会话可能仍在运行；恢复本任务将回到原会话继续等待，不会重发`);
  }
}

/** 回合收尾：复核轮直接带答复；执行轮快进远端分支并按实际 HEAD 核对 PR/SHA。 */
async function closeout(ctx: Ctx, text: string): Promise<VendorOutcome> {
  const { input, deps, repo, material } = ctx;
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
