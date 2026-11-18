/**
 * Devin Cloud 通道驱动：经 ego-browser 在 app.devin.ai 网页里跑云端会话。
 * 网页才是公司免费档位的真实入口：每次新建会话前页面核验 Capability 选中 Free（"Free (powered by SWE-2)"）
 * 且读到 "N/M in use" 席位有余，满额等待绝不改选付费档。续轮、返工、复核都读同一会话地址发跟进消息，
 * 同样先核验 Free 与席位，不新建会话。
 * 发送不是幂等的：按下发送前先在 lane 状态里落盘 attempt 标记（参照 grok-bot/turn.ts）。按下之后
 * 只做受理核对（会话列表与原会话里找本轮标记），绝不重发；不确定就明确受阻交人工核对。
 * 终稿只认本轮收尾约定之后、会话已 idle 的 SCK-DONE 回答，且连续两次读数一致。
 * 页面脚本的 goto 失败会被自己的 catch 吞掉，可能停在另一个合法会话上；驱动侧据脚本回的
 * wrong_session 识别这种情况（跟进发送按未就绪重试，轮询按未见本轮标记累计计次），并对每份回执再按
 * 回执里的 s.url 与目标会话独立比对一次（query/hash 规范化）——即使回执误报 ok:true，别的会话的
 * 内容也不当本轮受理或终稿，绝不重发。
 * 完成后 git fetch + --ff-only 快进本地工作树；非快进报错回合，绝不 reset。
 */
import { ensureBranchOnOrigin, fetchAndFastForward, type RepoInfo } from './repo.ts';
import { clearInflightAttempt, laneDigest, recordInflight, recordInflightAttempt, writeLaneState, type DevinSeatReading, type LaneState } from './state.ts';
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

async function openPullRequest({ deps, input, repo }: Ctx): Promise<string | undefined> {
  try {
    const result = await deps.exec('gh', ['pr', 'list', '--repo', repo.slug, '--head', repo.branch,
      '--state', 'open', '--json', 'url'], { cwd: input.cwd });
    if (result.code !== 0) return undefined;
    const rows = JSON.parse(result.stdout) as Array<{ url?: unknown }>;
    return rows.map(row => row.url).find((url): url is string =>
      typeof url === 'string' && url.startsWith(`https://github.com/${repo.slug}/pull/`) && /\/\d+$/.test(url));
  } catch { return undefined; }
}

/** 漏标记时只信远端客观交付：不能用已有本地提交或其它分支 PR 冒充本轮完成。 */
async function objectiveCloseout(ctx: Ctx, tail: string): Promise<VendorOutcome | undefined> {
  const { deps, input, repo } = ctx;
  try {
    const head = await fetchAndFastForward(deps.exec, input.cwd, repo.branch);
    if (!/^[a-f0-9]{40}$/i.test(head)) return undefined;
    const remote = await deps.exec('git', ['rev-parse', 'FETCH_HEAD'], { cwd: input.cwd });
    if (remote.code !== 0 || remote.stdout.trim() !== head) return undefined;
    const base = await deps.exec('git', ['fetch', 'origin', repo.defaultBranch], { cwd: input.cwd });
    if (base.code !== 0) return undefined;
    const count = await deps.exec('git', ['rev-list', '--count', `FETCH_HEAD..${head}`], { cwd: input.cwd });
    if (count.code !== 0 || !/^\d+$/.test(count.stdout.trim()) || Number(count.stdout.trim()) <= 0) return undefined;
    const pr = await openPullRequest(ctx);
    if (!pr) return undefined;
    // 页面尾段仅作摘要，不采信其中的手写 SHA/PR 或首行口令。
    const summary = tail.replace(/^(?:PR|SHA|提交|工作结果|复核结论)\s*[:：].*$/gim, '').trim();
    return { kind: 'done', text: `Devin 会话已空闲，依据远端分支新提交与 OPEN PR 收尾。\n${summary}\nPR: ${pr}\nSHA: ${head}` };
  } catch { return undefined; }
}

interface Ctx {
  input: LaneInput; deps: LaneDeps; repo: RepoInfo;
  material: { task: string; findings?: string; review: boolean; title: string };
  prompt: string; state: LaneState;
  digest: string; key: string; deadline: number;
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
  // 本轮标记由稳定投递键决定：同一投递内正文重排/换目录仍得到同一标记，只有新一轮才换标记。
  // 上一轮本地代跑回传已按下但未确认：优先追踪这条 attempt 与已用轮数，只核对、不再代跑或重发。
  const pendingAssist = state.taskId && /^SCK-[a-f0-9]+$/.test(state.devin?.attempt ?? '')
    ? state.devin!.attempt : undefined;
  let marker = pendingAssist ?? (/^SCK-[a-f0-9]+$/.test(state.taskId ?? '') ? state.taskId!
    : `SCK-${(state.delivery ? laneDigest(input.provider, state.delivery) : ctx.digest).slice(0, 10)}`);
  const continuing = Boolean(state.vendorSession) || Boolean(state.taskId) || Boolean(input.resumeId);
  const followUp = continuing && !material.review
    ? '\n这是同一任务的后续轮次：该分支上可能已有你的云端会话推送过改动并开过 PR，请先拉取远端分支现状，在既有 PR 上继续更新，不要另开重复 PR。'
    : '';
  const message = `[SCK-ROUND ${marker}]\n\n${prompt}${followUp}\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${marker}]」单独成行开头，随后是完整最终答复。\n`;

  const persist = () => {
    writeLaneState(input.commDir, state);
    recordInflight(input.stateRoot, input.provider, ctx.key, state);
  };
  /** 只清本目录的 attempt；共享登记交给 persist()（已有 taskId 时）或 abandonAttempt() 处理。 */
  const dropLocalAttempt = () => {
    if (!state.devin) return;
    delete state.devin.attempt;
    delete state.devin.attemptAt;
  };
  /** 受理或拿到会话地址后，落点会话由 taskUrl 记录，不再单独保留。 */
  const forgetAttemptSession = () => {
    if (state.devin) delete state.devin.attemptSession;
  };
  /** 确认没有按下发送：本目录与共享登记里的发送意图一起撤销，之后才允许再试。 */
  const abandonAttempt = () => {
    dropLocalAttempt();
    forgetAttemptSession();
    clearInflightAttempt(input.stateRoot, input.provider, ctx.key);
  };
  const loginFail = () => fail('app.devin.ai 未登录或登录已过期（需要老板在 ego-browser 里重新登录 Devin）');
  const over = () => deps.now() > ctx.deadline;
  const sessionOf = (value: unknown): string | undefined =>
    typeof value === 'string' && DEVIN_SESSION_RE.test(value) ? value.split('?')[0]!.split('#')[0] : undefined;
  /** 会话地址比较：query/hash 规范化去掉（与页面脚本 sameSession 同规则）。 */
  const sameSession = (a: unknown, b: unknown): boolean => {
    const strip = (u: unknown) => String(u ?? '').split(/[?#]/)[0];
    return strip(a) === strip(b);
  };
  /**
   * 回执带了实际地址却不是本次目标会话：即使脚本回了 ok:true、即使那一页凑巧也有本轮同标记作者块，
   * 驱动层也不采信——这是脚本侧 sameSession 核验之外的独立第二道，防止导航/吞错让读数落在别的会话上。
   * 回执没带地址时交给脚本自己的 wrong_session 判定（真实脚本总会带 location.href）。
   */
  const offSession = (reply: Reply, target: string | undefined): boolean =>
    target !== undefined && typeof reply?.url === 'string' && reply.url !== '' && !sameSession(reply.url, target);
  /** 记下发送前核验到的档位与席位（审计用）：只保留 Capability 文字与用量数字。 */
  const readSeats = (step: DevinSeatReading['step'], reply: Reply) => {
    const seats = reply?.seats as { used?: unknown; total?: unknown } | null | undefined;
    if (typeof reply?.cap !== 'string' || typeof seats?.used !== 'number' || typeof seats?.total !== 'number') return;
    state.devin = { ...state.devin, seats: { step, cap: reply.cap, used: seats.used, total: seats.total, at: deps.now() } };
  };

  // 本目录残留的旧摘要发送标记：只丢掉本目录这一份。旧摘要的共享登记保留（无法确定它是否已按下，只核对不重发）；
  // 本摘要的共享登记可能正属于别的员工目录的在途发送，这里绝不能清。
  if (state.devin?.attempt && state.devin.attempt !== marker) { dropLocalAttempt(); forgetAttemptSession(); }
  if (state.devin?.attempt === marker && !state.taskId) {
    state.taskId = marker;
    state.submittedAt ??= deps.now();
    // 保留共享 attempt 直到 persist() 用 taskId 覆盖它：中间崩溃时别的目录仍只会核对，不会重发。
    dropLocalAttempt();
    persist();
    deps.progress('上次按下发送后没有拿到结果，先核对是否已受理（不重发）', 'failed');
  }
  if (pendingAssist) {
    // 代跑回传的 attempt 已在发送前落盘（含轮数）：这里只把它当本轮标记核对，绝不再次调用代跑或发送。
    state.taskId = pendingAssist;
    state.submittedAt ??= state.devin?.attemptAt ?? deps.now();
    persist();
    deps.progress('上次本地代跑回传未确认，先核对原会话（不重发、不再代跑）', 'failed');
  }

  // ---- 阶段一：确定本轮会话地址。只有这里会按下发送，且只在「尚未按下」时发送。 ----
  // 只认本轮自己记下的会话地址。vendorSession 是之前回合的会话，不能拿来核对当前的在途发送：
  // 未确认受理的发送看 attemptSession（续轮原会话）或会话列表（新会话），见下方恢复分支。
  let sessionUrl = state.taskId ? sessionOf(state.taskUrl) : undefined;
  let recoverMisses = 0, capabilityMisses = 0;
  while (!sessionUrl) {
    if (!state.taskId) {
      const follow = sessionOf(state.vendorSession);
      // 按下发送前先落盘 attempt：本目录写 .lane/state.json，共享根写 inflight/<投递键>.json。
      // 之后无论脚本如何结束、换到哪个员工目录，都只核对是否已受理，绝不再按发送。
      const at = deps.now();
      state.devin = { ...state.devin, attempt: marker, attemptAt: at, attemptSession: follow };
      recordInflightAttempt(input.stateRoot, input.provider, ctx.key, marker, at, follow, state.task);
      persist();
      deps.progress(follow ? `尝试在原 Devin 会话发送本轮消息（${marker}）` : `尝试新建 Devin Cloud 会话（${marker}）`, 'attempt');
      const r = await browse(follow ? devinFollowScript(follow, marker, message, home) : devinSendScript(home, marker, message), 150_000) as Reply;
      const url = sessionOf(r?.url) ?? sessionOf(r?.recovered);
      // 续轮的目标就是原会话：回执带地址时必须与它一致。脚本在发送前已核验 location.href，驱动层再按回执
      // 地址独立核对一次；送入后页面若跳到别的合法会话，那页即便有同标记块也不当受理证据、不采信其终稿。
      const offTarget = follow !== undefined && url !== undefined && !sameSession(url, follow);
      const accepted = r?.ok === true && url !== undefined && !offTarget;
      // ok 即脚本已越过按下发送；拿不到会话地址也只能核对，绝不当成未发出而重发。
      const pressed = r?.ok === true || r?.code === 'pressed' || r?.code === 'not_echoed';
      // 没有按下发送（登录、页面、档位、席位、浏览器）：撤销本目录与共享的 attempt，之后才允许再试。
      if (!pressed) { abandonAttempt(); persist(); }
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
      if (r?.code === 'wrong_session') {
        // goto 失败被页面脚本自己的 catch 吞掉，没能停在原会话地址上：没碰发送按钮（pressed 已为 false，
        // 上面已撤销 attempt），单纯当页面未就绪重试，绝不把停错的那个会话当成本轮结果。
        if (over()) return fail(`Devin 网页反复没能停在原会话地址上（当前 ${String(r.url ?? '未知')}，目标 ${follow}），${maxMinutes} 分钟内未能发出续轮消息`);
        deps.progress(`Devin 页面没有停在原会话，稍后重试（当前 ${String(r.url ?? '未知')}）`, 'failed');
        await deps.sleep(pollMs);
        continue;
      }
      if (accepted) {
        // 受理证据：转录里看到本轮标记（或会话列表/原会话已有它）。只有这时才算已派。
        sessionUrl = url;
        state.taskId = marker; state.taskUrl = url; state.vendorSession = url; state.submittedAt = deps.now();
        dropLocalAttempt();
        forgetAttemptSession();
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
        // 已按下发送但拿不到可信的受理证据：记为本轮在途，接下来只做核对，绝不重发。续轮回执若带着别的
        // 会话地址（发送后导航/tab 漂移），落点仍记原会话——只在原会话里按本轮标记确认受理，不去轮询那页。
        const landing = offTarget ? follow : url;
        sessionUrl = landing;
        state.taskId = marker; state.submittedAt = deps.now();
        // 没拿到会话地址时保留落点会话（续轮的原会话），之后的核对只看它；拿到地址后由 taskUrl 记录。
        if (landing) { state.taskUrl = landing; state.vendorSession = landing; forgetAttemptSession(); }
        dropLocalAttempt();
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
    // 在途但会话地址未知：只核对受理，绝不再发送。续轮的落点会话只看它的转录（有本轮标记才算受理）；
    // 新会话的落点未知，才在会话列表与最近会话里按标记找。
    const pending = state.devin?.attemptSession;
    const r = pending
      ? await browse(devinSessionScript(pending, marker), 90_000) as Reply
      : await browse(devinRecoverScript(home, marker), 150_000) as Reply;
    if (r?.code === 'login_required') return loginFail();
    // 核对的落点是已知的原会话时必须停在它上面；回执带着别的会话地址时，那页的 markerSeen 不算受理证据。
    const found = pending
      ? (r?.ok === true && r?.markerSeen === true && !offSession(r, pending) ? pending : undefined)
      : sessionOf(r?.found);
    if (found) {
      sessionUrl = found;
      state.taskUrl = found; state.vendorSession = found;
      dropLocalAttempt(); forgetAttemptSession();
      persist();
      deps.progress(`Devin Cloud 会话已核对受理：${found}`, 'accepted');
      break;
    }
    if (++recoverMisses >= RECOVERY_LIMIT || over()) {
      const scope = pending
        ? `原会话 ${pending} 里都没有找到本轮标记（${marker}）`
        : `会话列表与最近会话里都没有找到本轮标记（${marker}；列表 ${String(r?.listed ?? '?')} 条，核对 ${String(r?.probed ?? '?')} 条）`;
      return blocked(`Devin Cloud 上一轮发送可能已按下，但${scope}。无法确认是否已受理，所以未自动重发（避免重复会话与席位）。请人工核对 app.devin.ai ${pending ? '原会话' : '会话列表'}：已受理则在原会话里看结果，未受理再由老板决定是否重派。在途状态已保留。`);
    }
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
    if (s?.code === 'wrong_session' || offSession(s, sessionUrl)) {
      // 页面没能停在本轮轮询的会话地址上（goto 失败被脚本自己的 catch 吞掉，留在另一个合法会话；或回执里
      // 的 location.href 与目标不一致）：不采信这次读数，按「没看到本轮标记」累计未受理计次，绝不把停错的
      // 那个会话内容当本轮终稿，也绝不重发。
      if (++misses >= MARKER_MISS_LIMIT)
        return blocked(`Devin 页面没能停在本轮轮询的会话地址上（当前 ${String(s?.url ?? '未知')}，目标 ${sessionUrl}），无法确认是否受理。未重发（避免重复发送），在途状态已保留。请人工核对会话 ${sessionUrl}，确认后恢复本任务即可。`);
      deps.progress(`Devin Cloud 页面不在预期会话，重试中（当前 ${String(s?.url ?? '未知')}）`, 'failed');
    } else if (s?.ok === true) {
      const status = String(s.status ?? 'unknown');
      const answer = typeof s.done === 'string' && s.done.trim() ? s.done.trim() : undefined;
      const seen = s.markerSeen === true;
      // 只有已核验本轮用户锚点（seen）后的 blocked 才可能代跑；来源只取本轮锚点之后的 Devin 作者块。
      if (status === 'blocked' && seen) {
        const tail = String(s.tail ?? '').slice(-400);
        const used = state.devin?.assistRounds ?? 0;
        const pending = state.devin?.attempt;
        if (pending)
          return blocked(`Devin 停下来等待人工输入；上一轮本地代跑回传（${pending}）尚未确认，本轮只核对不重发、不再代跑，需老板裁决：${tail}`);
        const agentTail = typeof s.agentTail === 'string' ? s.agentTail : '';
        if (used < 3 && deps.assist && agentTail.trim()) {
          deps.progress(`Devin 等待输入，尝试本地代跑协助（第 ${used + 1}/3 轮）`);
          const assist = await deps.assist({
            provider: input.provider,
            phase: material.review ? 'review' : 'doing',
            transcriptTail: agentTail,
            round: used + 1,
          });
          if (assist.decision === 'reply' && typeof assist.message === 'string' && assist.message.trim()) {
            const nextRound = used + 1;
            const followMarker = `SCK-${laneDigest(input.provider, `${ctx.key}:assist:${nextRound}`).slice(0, 10)}`;
            const followText = `[SCK-ROUND ${followMarker}]\n\n本地驻场管理员代跑结果（第 ${nextRound}/3 轮`
              + `${assist.toolExecuted ? `，工具 ${assist.toolExecuted}` : ''}；仅为本地代跑，不代表云端获得账号或远程登录能力）：\n${assist.message.trim()}\n\n`
              + `请依据上述结果继续本轮工作。收尾约定：本轮的最后一条答复以「[SCK-DONE ${followMarker}]」单独成行开头，随后是完整最终答复。\n`;
            const at = deps.now();
            // 发送前先落盘：轮数与 attempt 一起持久化（本目录 + 共享登记），未确认时恢复只核对、零重发。
            state.devin = { ...state.devin, assistRounds: nextRound, attempt: followMarker, attemptAt: at, attemptSession: sessionUrl };
            recordInflightAttempt(input.stateRoot, input.provider, ctx.key, followMarker, at, sessionUrl, state.task, nextRound);
            persist();
            const r = await browse(devinFollowScript(sessionUrl, followMarker, followText, home), 150_000) as Reply;
            const url = sessionOf(r?.url) ?? sessionOf(r?.recovered);
            const offTarget = url !== undefined && !sameSession(url, sessionUrl);
            const accepted = r?.ok === true && url !== undefined && !offTarget;
            const pressed = r?.ok === true || r?.code === 'pressed' || r?.code === 'not_echoed';
            if (accepted) {
              marker = followMarker;
              state.taskId = followMarker;
              state.submittedAt = at;
              state.taskUrl = url!;
              state.vendorSession = url!;
              dropLocalAttempt(); forgetAttemptSession();
              persist();
              settled = undefined; misses = 0; idleNoDone = 0;
              deps.progress(`本地代跑结果已回传原会话（${followMarker}），继续轮询`, 'accepted');
              continue;
            }
            // 未回显：attempt 与轮数保持落盘，恢复时只核对这条 attempt，绝不重发或再次代跑。
            if (pressed) persist();
            else { abandonAttempt(); persist(); }
            return blocked(`Devin 停下来等待人工输入，本地代跑结果未能确认回传原会话（第 ${nextRound} 轮，未重发）：${tail}`);
          }
          // escalate 或无可用回复：落盘已用轮数后交老板
          if (assist.decision === 'escalate') {
            state.devin = { ...state.devin, assistRounds: used + 1 };
            persist();
            return blocked(`Devin 停下来等待人工输入，本地协助转交老板（${assist.reason ?? '无可用协助'}）：${tail}`);
          }
        }
        return blocked(`Devin 停下来等待人工输入，需要老板在会话里答复：${tail}`);
      }
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
        if (idleNoDone >= IDLE_NO_DONE_LIMIT) {
          if (!material.review) {
            const objective = await objectiveCloseout(ctx, String(s.tail ?? '').slice(-2000));
            if (objective) return objective;
          }
          return blocked(`Devin 已停止但没有按约定以「[SCK-DONE ${marker}]」开头给出终稿，请人工核对会话：${String(s.tail ?? '').slice(-400)}`);
        }
      }
      deps.progress(status === 'working' ? `Devin Cloud 工作中（${marker}）`
        : answer && status === 'idle' ? 'Devin Cloud 已给出终稿，确认中'
        : `Devin Cloud 等待终稿（${marker}，页面状态 ${status}）`);
    }
    if (over())
      // 会话早已受理（state.taskId 已定），超时不是供应商崩溃或额度故障：按受阻收尾并保留会话地址与在途
      // 标记，恢复时只回原会话继续轮询，绝不重发；不按硬错误收尾，避免被上层当成空交付回收成 silent-turn。
      return blocked(`Devin Cloud 会话 ${sessionUrl} 超过配置时限仍未给出终稿（标记 ${marker}），会话可能仍在运行；恢复本任务将回到原会话继续等待，不会重发`);
  }
}

/** 回合收尾：复核轮直接带答复；执行轮快进远端分支并按实际 HEAD 核对 PR/SHA。 */
async function closeout(ctx: Ctx, text: string): Promise<VendorOutcome> {
  const { input, deps, repo, material } = ctx;
  if (material.review) return { kind: 'done', text };

  let pr = /^PR:\s*(\S+)/m.exec(text)?.[1];
  const sha = /^SHA:\s*([0-9a-f]{7,40})/im.exec(text)?.[1];
  try {
    const head = await fetchAndFastForward(deps.exec, input.cwd, repo.branch);
    if (!pr) {
      pr = await openPullRequest(ctx);
      if (pr) text += `\nPR: ${pr}`;
    }
    if (!pr) return { kind: 'blocked', text: `Devin 已把改动推上分支（本地已快进至 ${head.slice(0, 12)}），但答复里没有 PR 行：${text.slice(0, 300)}` };
    // 公司收尾以远端分支实际 HEAD 为准：Devin 声明的 SHA 不一致时改写并注明。
    if (!sha) return { kind: 'done', text: `${text}\nSHA: ${head}` };
    if (head.startsWith(sha)) return { kind: 'done', text: text.replace(/^SHA:\s*\S+/im, `SHA: ${head}`) };
    return { kind: 'done',
      text: `${text.replace(/^SHA:\s*\S+/im, `SHA: ${head}`)}\n（Devin 声明的 SHA ${sha} 与远端分支实际 HEAD 不一致，以实际 HEAD 为准）` };
  } catch (error) {
    if (!pr && !sha) return { kind: 'blocked', text: `Devin 未在分支 ${repo.branch} 上留下可快取的改动：${text.slice(0, 300)}` };
    return { kind: 'error', text: (error as Error).message };
  }
}
