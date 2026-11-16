/**
 * Devin Cloud 通道驱动：经 ego-browser 在 app.devin.ai 网页里跑云端会话。
 * 网页才是公司免费档位的真实入口：每次新建会话前页面核验 Capability 选中 Free（"Free (powered by SWE-2)"）
 * 且读到 "N/M in use" 席位有余，满额等待绝不改选付费档。续轮、返工、复核都读同一会话地址发跟进消息，
 * 同样先核验 Free 与席位，不新建会话。
 * 发送不是幂等的：按下发送前先在 lane 状态里落盘 attempt 标记（参照 grok-bot/turn.ts）。按下之后
 * 只做受理核对（会话列表与原会话里找本轮标记），绝不重发；不确定就明确受阻交人工核对。
 * 终稿只认本轮收尾约定之后、会话已 idle 的 SCK-DONE 回答，且连续两次读数一致。
 * 完成后 git fetch + --ff-only 快进本地工作树；非快进报错回合，绝不 reset。
 */
import { ensureBranchOnOrigin, fetchAndFastForward, type RepoInfo } from './repo.ts';
import { recordInflight, writeLaneState, type DevinSeatReading, type LaneState } from './state.ts';
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
  /** 本轮 Devin 会话仍在途（已按下发送或已受理）：受阻后保留标记与会话地址，恢复时只核对/轮询，不再发送。 */
  inflight?: boolean;
}

type Browse = NonNullable<LaneDeps['browse']>;
type Reply = Record<string, unknown> | undefined;

/** 空闲会话里连续几轮看不到本轮标记，才认定转录里没有受理（转录可能还在渲染）。之后受阻交人工核对，绝不重发。 */
const MARKER_MISS_LIMIT = 3;
/** 「已按下发送但受理未确认」时在会话列表与原会话里核对的有界次数。 */
const RECOVERY_LIMIT = 4;
/** 页面读不到 Capability=Free 时的有界重试次数；仍不是 Free 就受阻，不改选付费档。 */
const CAPABILITY_LIMIT = 3;
/** 会话已 idle 却没有本轮 SCK-DONE 终稿，连续几次读数后受阻交人工核对。 */
const IDLE_NO_DONE_LIMIT = 3;

export async function driveDevin(ctx: Ctx): Promise<VendorOutcome> {
  const { input, deps, repo, material, prompt, state } = ctx;
  const fail = (text: string): VendorOutcome => ({ kind: 'error', text });
  const blocked = (text: string): VendorOutcome => ({ kind: 'blocked', text, inflight: state.taskId !== undefined });
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
  const clearAttempt = () => {
    if (!state.devin) return;
    delete state.devin.attempt;
    delete state.devin.attemptAt;
  };
  const loginFail = () => fail('app.devin.ai 未登录或登录已过期（需要老板在 ego-browser 里重新登录 Devin）');
  const over = () => deps.now() > ctx.deadline;
  const sessionOf = (value: unknown): string | undefined =>
    typeof value === 'string' && DEVIN_SESSION_RE.test(value) ? value.split('?')[0]!.split('#')[0] : undefined;
  /** 记下发送前核验到的档位与席位（审计用）：只保留 Capability 文字与用量数字。 */
  const readSeats = (step: DevinSeatReading['step'], reply: Reply) => {
    const seats = reply?.seats as { used?: unknown; total?: unknown } | null | undefined;
    if (typeof reply?.cap !== 'string' || typeof seats?.used !== 'number' || typeof seats?.total !== 'number') return;
    state.devin = { ...state.devin, seats: { step, cap: reply.cap, used: seats.used, total: seats.total, at: deps.now() } };
  };

  // 上一轮残留的发送标记：同一摘要说明按下过发送却没有定论（进程中断），只核对不重发；旧摘要的残留直接清掉。
  if (state.devin?.attempt && state.devin.attempt !== marker) clearAttempt();
  if (state.devin?.attempt === marker && !state.taskId) {
    state.taskId = marker;
    state.submittedAt ??= deps.now();
    clearAttempt();
    persist();
    deps.progress('上次按下发送后没有拿到结果，先核对是否已受理（不重发）', 'failed');
  }

  // ---- 阶段一：确定本轮会话地址。只有这里会按下发送，且只在「尚未按下」时发送。 ----
  let sessionUrl = state.taskId ? (sessionOf(state.taskUrl) ?? sessionOf(state.vendorSession)) : undefined;
  let recoverMisses = 0, capabilityMisses = 0;
  while (!sessionUrl) {
    if (!state.taskId) {
      const follow = sessionOf(state.vendorSession);
      // 按下发送前先落盘 attempt：之后无论脚本如何结束，重启都只核对、不再发送。
      state.devin = { ...state.devin, attempt: marker, attemptAt: deps.now() };
      persist();
      deps.progress(follow ? `尝试在原 Devin 会话发送本轮消息（${marker}）` : `尝试新建 Devin Cloud 会话（${marker}）`, 'attempt');
      const r = await browse(follow ? devinFollowScript(follow, marker, message) : devinSendScript(home, marker, message), 150_000) as Reply;
      const url = sessionOf(r?.url) ?? sessionOf(r?.recovered);
      const accepted = r?.ok === true && url !== undefined;
      // ok 即脚本已越过按下发送；拿不到会话地址也只能核对，绝不当成未发出而重发。
      const pressed = r?.ok === true || r?.code === 'pressed' || r?.code === 'not_echoed';
      // 没有按下发送（登录、页面、档位、席位、浏览器）：撤销 attempt，之后才允许再试。
      if (!pressed) { clearAttempt(); persist(); }
      if (r?.code === 'login_required') return loginFail();
      if (r?.code === 'capability') {
        const detail = String(r.detail ?? '').slice(0, 300);
        if (++capabilityMisses >= CAPABILITY_LIMIT)
          return blocked(`Devin 页面未能确认选中 Free 档位或席位计数，本轮未发出（已重试 ${CAPABILITY_LIMIT} 次）：${detail}。不切付费档、不改用其它模型，也不回退到账号默认；页面恢复后恢复本任务即可。`);
        deps.progress(`Devin 页面未确认 Free 档位，稍后重试（${capabilityMisses}/${CAPABILITY_LIMIT}）`, 'failed');
        await deps.sleep(pollMs);
        continue;
      }
      if (r?.code === 'quota_full') {
        if (over()) return blocked(`Devin Free 席位持续已满（${String(r.seats ?? '?/?')} in use），本轮未发出；席位空出后恢复本任务即可，不会另建重复会话`);
        deps.progress(`Devin Free 席位已满（${String(r.seats ?? '?/?')} in use），等待空位`, 'failed');
        await deps.sleep(pollMs);
        continue;
      }
      if (r?.code === 'busy') {
        if (over()) return blocked('Devin 会话一直在处理上一轮，续轮消息没有发出；会话空闲后恢复本任务即可');
        deps.progress('Devin 会话正忙，等它空下来再发续轮消息', 'failed');
        await deps.sleep(pollMs);
        continue;
      }
      if (accepted) {
        // 受理证据：转录里看到本轮标记（或会话列表/原会话已有它）。只有这时才算已派。
        sessionUrl = url;
        state.taskId = marker; state.taskUrl = url; state.vendorSession = url; state.submittedAt = deps.now();
        clearAttempt();
        readSeats(follow ? 'follow' : 'send', r);
        persist();
        const seat = state.devin?.seats;
        const seatText = seat ? `${seat.used}/${seat.total} in use` : '席位未读出';
        deps.progress(r.already || r.recovered
          ? `Devin Cloud 已有本轮消息（${marker}），已受理，继续等待`
          : `Devin Cloud 已受理（${marker}，Free ${seatText}）`, 'accepted');
        break;
      }
      if (pressed) {
        // 已按下发送但拿不到受理证据：记为本轮在途，接下来只做核对，绝不重发。
        sessionUrl = url;
        state.taskId = marker; state.submittedAt = deps.now();
        if (url) { state.taskUrl = url; state.vendorSession = url; }
        clearAttempt();
        persist();
        deps.progress(`Devin Cloud 已按下发送但未确认受理（${marker}），转入核对，不重发`, 'failed');
        continue;
      }
      // 页面未就绪、浏览器没起来：尚未按下发送，可重试。
      if (over()) return fail(`Devin 网页在 ${maxMinutes} 分钟内一直没准备好或浏览器不可用，本轮未发出`);
      deps.progress('Devin 页面未就绪，稍后重试', 'failed');
      await deps.sleep(pollMs);
      continue;
    }
    // 在途但会话地址未知：只核对受理，绝不再发送。
    const r = await browse(devinRecoverScript(home, marker), 150_000) as Reply;
    if (r?.code === 'login_required') return loginFail();
    const found = sessionOf(r?.found);
    if (found) {
      sessionUrl = found;
      state.taskUrl = found; state.vendorSession = found;
      persist();
      deps.progress(`Devin Cloud 会话已核对受理：${found}`, 'accepted');
      break;
    }
    if (++recoverMisses >= RECOVERY_LIMIT || over())
      return blocked(`Devin Cloud 已按下发送，但会话列表与最近会话里都没有找到本轮标记（${marker}；列表 ${String(r?.listed ?? '?')} 条，核对 ${String(r?.probed ?? '?')} 条）。无法确认是否已受理，所以未自动重发（避免重复会话与席位）。请人工核对 app.devin.ai 会话列表：已受理则在原会话里看结果，未受理再由老板决定是否重派。在途状态已保留。`);
    deps.progress(`Devin Cloud 受理核对中（${marker}），暂未见本轮标记`, 'failed');
    await deps.sleep(pollMs);
  }
  if (!sessionUrl) return blocked(`Devin Cloud 本轮没有可核对的会话（标记 ${marker}）`);
  // 轮询开始就把会话地址固化进可复用字段：本轮超时后，续轮仍在同一 Devin 会话里发跟进消息。
  if (state.vendorSession !== sessionUrl) { state.vendorSession = sessionUrl; persist(); }

  // ---- 阶段二：轮询会话页到终稿/提问/超时。 ----
  let settled: string | undefined, misses = 0, idleNoDone = 0;
  for (;;) {
    await deps.sleep(pollMs);
    const s = await browse(devinSessionScript(sessionUrl, marker), 90_000) as Reply;
    if (s?.code === 'login_required') return loginFail();
    if (s?.ok === true) {
      const status = String(s.status ?? 'unknown');
      const answer = typeof s.done === 'string' && s.done.trim() ? s.done.trim() : undefined;
      const seen = s.markerSeen === true;
      if (status === 'blocked') return blocked(`Devin 停下来等待人工输入，需要老板在会话里答复：${String(s.tail ?? '').slice(-400)}`);
      // 不工作时看不到本轮标记：转录里没有受理。连续确认后受阻交人工核对；绝不重发，在途状态保留。
      if (status !== 'working' && !seen) {
        if (++misses >= MARKER_MISS_LIMIT)
          return blocked(`Devin 会话的转录里一直找不到本轮消息（${marker}），无法确认是否受理。未重发（避免重复发送），在途状态已保留。请人工核对会话 ${sessionUrl}，确认后恢复本任务即可。`);
      } else misses = 0;
      // 终稿只认「会话已 idle 且本轮标记可见」的回答；unknown 状态不收尾。连续两次读数一致才收尾，防半截答复。
      if (status === 'idle' && seen && answer) {
        idleNoDone = 0;
        if (settled === answer) {
          const out = await closeout(ctx, answer);
          return out.kind === 'blocked' ? { ...out, inflight: true } : out;
        }
        settled = answer;
      } else {
        settled = undefined;
        idleNoDone = status === 'idle' && seen && !answer ? idleNoDone + 1 : 0;
        if (idleNoDone >= IDLE_NO_DONE_LIMIT)
          return blocked(`Devin 已停止但没有按约定以「[SCK-DONE ${marker}]」开头给出终稿，请人工核对会话：${String(s.tail ?? '').slice(-400)}`);
      }
      deps.progress(status === 'working' ? `Devin Cloud 工作中（${marker}）`
        : answer && status === 'idle' ? 'Devin Cloud 已给出终稿，确认中'
        : `Devin Cloud 等待终稿（${marker}，页面状态 ${status}）`);
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
