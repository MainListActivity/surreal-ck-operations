/**
 * 云端员工通道核心：把公司回合（task.md + findings）翻译成供应商云端任务，等待终态，
 * 按公司收尾协议产出最终答复。所有外部交互（子进程、HTTP、时间）都经 LaneDeps 注入，
 * 测试可以完全不触网不碰 git 跑通各分支。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isLaneProvider, type LaneProvider } from '../native-args.ts';
import { WEB_CHAT_PROVIDERS } from '../native-args.ts';
import { bodyOfDispatch } from '../../outbound-render.ts';
import type { McpOutcome } from '../../contracts.ts';
import { clearInflight, clearSettledInflight, inflightSession, laneDigest, readClaimDelivery, readClaimTask, readInflight, readInflightOfTask, readLaneState, recordInflight, writeLaneState, type InflightEntry, type LaneState } from './state.ts';
import { repoInfo, type ExecFn, type RepoInfo } from './repo.ts';
import { driveCodex } from './codex.ts';
import { devinCloudModel, driveDevin } from './devin.ts';
import { driveJules } from './jules.ts';

export { isLaneProvider, type LaneProvider };

export interface LaneConfig {
  /** codex-cloud：owner/repo → 云端环境 ID 或环境标签（缺省用仓库名）。 */
  environments?: Record<string, string>;
  /** jules：24 小时内公司创建的会话上限（额度观察用）。 */
  dailyLimit?: number;
  /** jules：同时在途会话上限，超出按受阻处理。 */
  maxConcurrent?: number;
  /** devin-cloud：云端会话的模型，只能缺省或为 free（每个用户有免费会话额度；公司派工只用它，其它值配置校验与执行入口都拒绝）。 */
  model?: 'free';
  /** 单轮云端任务最长等待分钟数，默认 180。 */
  maxMinutes?: number;
  /** 测试用：轮询间隔毫秒，默认 25000。 */
  pollMs?: number;
  /** 命令名 → 绝对路径（codex、devin、gh、git 等）；配置后按此路径执行，其所在目录前置进子进程 PATH。 */
  bin?: Record<string, string>;
}

/** native-runner.json 的 lanes 段校验；执行端启动时调用，配置非法直接拒绝启动。 */
export function validateLanes(lanes: unknown): asserts lanes is Partial<Record<LaneProvider, LaneConfig>> {
  for (const [provider, lane] of Object.entries((lanes ?? {}) as Record<string, unknown>)) {
    if (!isLaneProvider(provider) || !lane || typeof lane !== 'object')
      throw new Error('原生执行端 lanes 配置无效：只允许 codex-cloud、devin-cloud、jules、warp、grok-bot、muse-web、chatgpt-web、gemini-web');
    for (const [key, value] of Object.entries(lane as Record<string, unknown>)) {
      if (key === 'environments') {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.entries(value as Record<string, unknown>).some(([repo, env]) => !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof env !== 'string' || !env))
          throw new Error(`lanes.${provider}.environments 必须是 "owner/repo" → 环境 ID/标签 的映射`);
      } else if (key === 'bin') {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.entries(value as Record<string, unknown>).some(([name, path]) => !/^[a-zA-Z0-9._-]+$/.test(name) || typeof path !== 'string' || !isAbsolute(path)))
          throw new Error(`lanes.${provider}.bin 必须是命令名 → 绝对路径 的映射`);
      } else if (key === 'model') {
        if (provider !== 'devin-cloud') throw new Error(`lanes.${provider} 不接受 model`);
        devinCloudModel(value);
      } else if (!['dailyLimit', 'maxConcurrent', 'maxMinutes', 'pollMs'].includes(key) || typeof value !== 'number' || !(value > 0))
        throw new Error(`lanes.${provider}.${key} 必须是正数`);
      if (provider === 'warp' && !['bin', 'maxMinutes'].includes(key))
        throw new Error(`lanes.warp 只接受 bin 与 maxMinutes，收到 ${key}`);
      if ((WEB_CHAT_PROVIDERS as readonly string[]).includes(provider) && !['bin', 'maxMinutes', 'pollMs'].includes(key))
        throw new Error(`lanes.${provider} 只接受 bin、maxMinutes 与 pollMs，收到 ${key}`);
    }
  }
}

/** 进展所处的阶段：尝试（还没有受理证据）、已受理、未取得受理证据。只有 accepted 才能写成“已派”。 */
export type LaneProgressPhase = 'attempt' | 'accepted' | 'failed';

export interface LaneDeps {
  exec: ExecFn;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** 每步进展以 lane_status 事件输出给执行端活动流。 */
  progress(status: string, phase?: LaneProgressPhase): void;
  /**
   * ego-browser 页面脚本执行器（与 grok-bot 通道同签名）：devin-cloud 经网页入口执行时需要；
   * 其它通道不调用。脚本只回 `__RESULT__{json}`，已按下发送后中断回 `{code:'pressed'}`。
   */
  browse?(script: string, timeoutMs: number): Promise<Record<string, unknown> | undefined>;
  /**
   * Mode 1 本地工具代跑协助：云端会话 blocked 时由本地驻场管理员代跑绿区 ops 或给出技术澄清。
   * 不注入则按原逻辑受阻交老板。
   */
  assist?(input: {
    provider: string; phase: 'doing' | 'review'; transcriptTail: string; round: number;
  }): Promise<{ decision: 'reply' | 'escalate'; message?: string; reason?: string; toolExecuted?: string }>;
  /**
   * MCP-2：按下发送前对服务端 mcp_outcome 开闸（清上一轮旧结论）。成功返回 {opened:true}，
   * 失败/超时返回 undefined——本轮不采信任何 MCP 结论，照常发送。
   */
  mcpRoundOpen?(): Promise<{ opened: true } | undefined>;
  /**
   * MCP-2：轮询时读取本租约代际的 MCP 结构化结论（task.mcp_outcome）。没有结论、租约不符或
   * 失败返回 undefined，调用方回落原页面判定。
   */
  mcpOutcome?(): Promise<McpOutcome | undefined>;
}

export interface LaneInput {
  provider: LaneProvider;
  /** 派工消息原文：老板在派工消息页看到、改过的那条，路径已渲染成本机绝对路径。 */
  prompt: string;
  cwd: string;
  /** 员工通道目录：task.md、findings/、.lane/state.json 都在这里。 */
  commDir: string;
  /** 通道级状态目录（<native>/lanes）：jules 用量计数等跨会话状态。 */
  stateRoot?: string;
  config: LaneConfig;
  /** 逻辑会话续接 ID（nativeSessionId）。 */
  resumeId?: string;
  env: Record<string, string | undefined>;
}

/** 云端回合终态：success 也可能是「工作结果：受阻」文本（执行端按受阻收尾，不记供应商故障）。 */
export interface LaneOutcome { sessionId: string; status: 'success' | 'error'; text: string }

/** 受阻文本的首行必须整行就是它（执行端按首行判定）；原因写在下一行起。 */
const BLOCKED = '工作结果：受阻';

/** 复核轮：task.md 含待复核成果段。最终答复首行必须是复核结论，缺了按错误回合处理。 */
const REVIEW_MARKER = '## 待复核成果';
const REVIEW_PREFIX = /^复核结论：(通过|退回)/;

/**
 * 云端与网页通道的 agent 读不到本机文件、也调不了 sck：把派工消息里指向的文件内容附在消息后面。
 * findings 按通信目录里实际有的文件取，不看派工消息的措辞：领取时旧任务的 findings 已清掉（sidecar stageBrief），
 * 目录里有文件就是本任务最近一次退回；老板把消息改成什么样，退回意见都不会丢。复核轮不带。
 * message 是发给 agent 的正文：就是老板在派工消息页看到、改过的那条消息，文件路径换成“下文《…》”，后面附上文件内容。
 * 没有派工消息（少见）时为空，调用方退回到整份 task.md。
 */
export function taskMaterial(commDir: string, prompt?: string): { task: string; findings?: string; answer?: string; review: boolean; title: string; message?: string } {
  let task = '';
  try { task = readFileSync(join(commDir, 'task.md'), 'utf8'); } catch { /* 无 task.md：少见，仍按 prompt 执行 */ }
  const review = task.includes(REVIEW_MARKER);
  let findings: string | undefined;
  if (!review) {
    let names: string[] = [];
    try { names = readdirSync(join(commDir, 'findings')).filter(name => /^round-\d+\.md$/.test(name)).sort(); } catch { /* 没有退回过 */ }
    const latest = names.at(-1);
    if (latest) findings = readFileSync(join(commDir, 'findings', latest), 'utf8');
  }
  const title = (/^#\s+(.+)$/m.exec(task)?.[1] ?? task.split('\n').find(l => l.trim()) ?? '云端任务').trim().slice(0, 80);
  // 老板对上次受阻的答复（sidecar stageBrief 落盘；已被消化的答复领取时会删掉）。
  let answer: string | undefined;
  try { answer = readFileSync(join(commDir, 'answer.md'), 'utf8'); } catch { /* 没有待转达的答复 */ }
  const message = laneMessage(prompt, commDir, { task, findings, answer, review });
  return { task, findings, answer, review, title, ...(message ? { message } : {}) };
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 派工消息 → 发给读不到本机文件的 agent 的正文（见 taskMaterial）。 */
export function laneMessage(prompt: string | undefined, commDir: string,
  material: { task: string; findings?: string; answer?: string; review: boolean }): string | undefined {
  let body = bodyOfDispatch(prompt ?? '').trim();
  if (!body) return undefined;
  const dir = commDir.replace(/\/+$/, '');
  const attachments: string[] = [];
  const attach = (pattern: RegExp, title: string, content: string | undefined, always: boolean) => {
    const mentioned = pattern.test(body);
    if (mentioned) body = body.replace(new RegExp(pattern.source, 'g'), `下文《${title}》`);
    if (content?.trim() && (mentioned || always)) attachments.push(`## ${title}\n\n${content.trim()}`);
  };
  let notes: string | undefined;
  try { notes = readFileSync(join(commDir, 'notes.md'), 'utf8'); } catch { /* 这条线还没有笔记 */ }
  // 答复较短时消息正文里已经有老板的原话，不再附一遍；较长时正文指向 answer.md，这里附全文。
  attach(new RegExp(`${escapeRe(dir)}/answer\\.md`), '老板答复全文', material.answer, !body.includes('老板答复'));
  // 退回意见一定附上（返工轮）：老板把消息改成什么样都不会丢。
  attach(new RegExp(`${escapeRe(dir)}/findings/round-(?:\\d+|NN)\\.md|findings/round-(?:\\d+|NN)\\.md`), '上一轮的退回意见', material.findings, true);
  // 复核轮的待复核成果只在 task.md 里，一定附上；执行轮在消息指向它时附（需求或验收太长）。
  // 按任务卡组装的三段式正文（有“可以用：”“验证：”两段）自己就是完整的；其它正文（路线模板、旧模板、老板整段改写）可能靠 task.md 才完整，也附上。
  const selfContained = body.includes('\n可以用：') && body.includes('\n验证：');
  attach(new RegExp(`${escapeRe(dir)}/task\\.md`), '任务全文', material.task, material.review || !selfContained);
  attach(new RegExp(`${escapeRe(dir)}/notes\\.md`), '这条线的笔记', notes, false);
  // 公司命令这类 agent 调不了：去掉那句指引，免得它去找一个不存在的工具。
  body = body.replace(/需要账号、登录态或远程执行工具时，用 .{1,400}? call company_cmd_catalog 查可用的工作能力。/g, '')
    .replace(/公司工具直接调用：.{1,400}?sck list 查看。/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  return [body, ...attachments].join('\n\n');
}

/** 交给云端 agent 的完整 prompt。 */
export function vendorPrompt(input: LaneInput, repo: RepoInfo, material: ReturnType<typeof taskMaterial>, readOnly = false): string {
  const parts: string[] = [];
  if (material.review) {
    parts.push(`你在复核仓库 ${repo.slug} 分支 ${repo.branch} 上已提交的改动（PR 目标分支 ${repo.defaultBranch}）。`);
    if (input.provider === 'codex-cloud')
      parts.push('只做只读复核：除新建 `.sck/review.md` 写入复核结论外不改动任何文件，也不需要提交或推送。',
        '按下面的验收标准逐条独立复验，最终答复首行必须是「复核结论：通过」或「复核结论：退回」，随后逐条给出证据。');
    else
      parts.push('只做只读复核：不要修改文件、不要提交、不要推送。',
        '按下面的验收标准逐条独立复验，最终答复首行必须是「复核结论：通过」或「复核结论：退回」，随后逐条给出证据。');
  } else {
    parts.push(`在 GitHub 仓库 ${repo.slug} 的分支 ${repo.branch} 上完成下面的工作，并把全部改动提交推送到该分支（PR 目标分支 ${repo.defaultBranch}）。`);
    if (input.provider === 'devin-cloud') {
      parts.push(`同一个供应商会话可以先后处理不同仓库，但以本轮为准：仓库 ${repo.slug}、分支 ${repo.branch}。会话里之前轮次用过的仓库或分支不作数。写文件或提交前，核对当前工作树的 origin 远端与当前分支是否与本轮一致（工作目录路径可以和本机不同，只看仓库与分支）。不一致时，先找到、克隆或复用本轮仓库 ${repo.slug} 的正确任务工作树，核对它的 origin 与分支 ${repo.branch} 一致后再继续；只有取不到正确工作树时，才以「工作结果：受阻」收尾并说明原因，不在别的仓库或分支上改动或提交。`,
        `最终 PR 只开在本轮仓库 ${repo.slug}，head 为本轮分支 ${repo.branch}，目标分支 ${repo.defaultBranch}。`,
        '完成后确保远端分支上有提交、已开或更新一条到目标分支的 PR，最终答复末尾单独成行给出 `PR: <url>` 和 `SHA: <提交sha>`。',
        '如需查询受控测试/运行环境健康度、日志或测试账号（限 ops_info/ops_health/ops_origin_status/ops_origin_health/ops_origin_logs/ops_account_ensure/ops_login/ops_workspace_ensure），可输出单行 `[OPS-REQUEST] {"tool":"ops_health","args":{...}}` 并暂停等待，本地驻场管理员会代跑并将脱敏结果回传同一会话（最多 3 轮）。');
    }
    if (input.provider === 'codex-cloud')
      parts.push('工作结果由本地桥接进程应用与提交；只需把改动做完整。没有可交付的代码改动时，在最终消息里说明原因。');
  }
  // MCP-2：devin-cloud 执行与复核轮都追加公司 MCP 收尾指引；MCP 交卷是首选，[SCK-DONE] 保留作兜底。
  if (input.provider === 'devin-cloud') {
    const mcpTask = readClaimTask(input.commDir);
    if (mcpTask) {
      const submitHint = material.review ? '复核完成后用 task_review'
        : readOnly ? '完成后用 task_submit（本任务是只读任务：不提交代码、不开 PR）'
        : '改动已推送到本轮分支、PR 已开或更新之后用 task_submit';
      parts.push(`本轮公司任务 ID 是 ${mcpTask}。若本会话可用 sck-company MCP：先用 task_context 读任务；需要只读运维信息直接 company_ops（不必再写 [OPS-REQUEST]）；${submitHint}（受阻用 task_block）交卷——这是首选收尾方式；原「[SCK-DONE]」收尾约定保留作兜底。`);
    }
  }
  // 正文就是派工消息（老板看到、改过的那条），指向的文件内容附在后面；没有派工消息时退回到整份任务材料。
  if (material.message) { parts.push('', material.message); return parts.join('\n'); }
  if (material.answer !== undefined)
    parts.push('', '## 上次受阻与老板的答复（按答复接着做）', material.answer.trim());
  if (material.findings !== undefined)
    parts.push('', '## 复核退回意见（逐条修复）', material.findings.trim());
  parts.push('', material.task.trim() || input.prompt.trim());
  return parts.join('\n');
}

interface VendorOutcome {
  kind: 'done' | 'blocked' | 'error';
  text: string;
  /** error 且为供应商明确报告的终态失败（如 codex [ERROR]、Jules FAILED）：清除在途登记，允许重新提交。 */
  vendorTerminal?: boolean;
  /** blocked 且供应商会话仍在途（已按下发送）：保留在途登记，恢复时只核对，不再提交。 */
  inflight?: boolean;
}

/** 按供应商分派；返回该轮最终答复文本与性质。 */
async function drive(ctx: {
  input: LaneInput; deps: LaneDeps; repo: RepoInfo; readOnly?: boolean;
  material: ReturnType<typeof taskMaterial>; prompt: string;
  state: LaneState; digest: string; key: string; deadline: number;
}): Promise<VendorOutcome> {
  const { input } = ctx;
  if (input.provider === 'codex-cloud') return driveCodex(ctx);
  if (input.provider === 'devin-cloud') return driveDevin(ctx);
  return driveJules(ctx);
}

/**
 * 通道的任务工作树：claim.json 里派工分配的 worktree（code 任务是独立 task/<id8> 分支工作树）。
 * 会话 cwd 可能是共享主 checkout（老板可能在用），通道绝不在那上面执行 git/供应商命令。
 * warp 等本地通道也复用：有 claim 工作树就用它，没有则退回会话 cwd（本地 agent 不代公司做提交）。
 */
export function claimWorktree(commDir: string): { path: string; branch: string; readOnly: boolean } | { blocked: string } {
  let claim: { worktree?: { worktreePath?: unknown; branch?: unknown; intent?: unknown } } | undefined;
  try { claim = JSON.parse(readFileSync(join(commDir, 'claim.json'), 'utf8')); } catch { /* 缺 claim.json */ }
  const worktree = claim?.worktree;
  const path = typeof worktree?.worktreePath === 'string' ? worktree.worktreePath : undefined;
  const branch = typeof worktree?.branch === 'string' && worktree.branch.trim() ? worktree.branch.trim() : undefined;
  if (!path || !isAbsolute(path) || !existsSync(path) || !branch)
    return { blocked: '本次派工没有可用的任务工作树（claim.json 未给出存在的 worktreePath 与分支）' };
  // 只读任务工作树（work_intent 'read'）：intent 见过字符串与对象两种形状，都按只读认。
  const intent = typeof worktree?.intent === 'string' ? worktree.intent
    : (worktree?.intent && typeof worktree.intent === 'object' ? (worktree.intent as { kind?: unknown }).kind : undefined);
  return { path, branch, readOnly: intent === 'read' };
}

/** 一轮云端执行：识别仓库 → 组装 prompt → 提交或重连 → 收尾成公司协议文本。 */
export async function runLane(input: LaneInput, deps: LaneDeps): Promise<LaneOutcome> {
  const state = readLaneState(input.commDir) ?? { sessionId: `lane-${crypto.randomUUID()}` };
  const sessionId = input.resumeId ?? state.sessionId;
  const fail = (text: string): LaneOutcome => ({ sessionId, status: 'error', text });
  const blocked = (text: string): LaneOutcome => ({ sessionId, status: 'success', text: `${BLOCKED}\n${text}` });
  if (!isLaneProvider(input.provider)) return fail(`未知云端通道：${input.provider}`);
  if (input.provider === 'warp') return fail('warp 走本地桥接进程（src/runner/warp/main.ts），不经云端通道');
  if ((WEB_CHAT_PROVIDERS as readonly string[]).includes(input.provider)) return fail(`${input.provider} 走网页桥接进程（src/runner/grok-bot/main.ts），不经云端通道`);

  // 云端命令只允许在派工分配的任务工作树里执行；没有可用工作树时一个 git/供应商命令都不发。
  const worktree = claimWorktree(input.commDir);
  if ('blocked' in worktree)
    return blocked(`云端通道只在任务分配的工作树中执行，${worktree.blocked}。`);
  const repo = await repoInfo(deps.exec, worktree.path).catch(() => undefined);
  if (!repo) return blocked('任务工作树不是已关联 GitHub origin 的代码工作树，云端通道只承接代码任务。');
  if (repo.branch !== worktree.branch)
    return blocked(`任务工作树当前分支 ${repo.branch} 与派工要求的分支 ${worktree.branch} 不一致，拒绝在其中执行。`);
  if (repo.branch === repo.defaultBranch)
    return blocked(`任务工作树在默认分支 ${repo.defaultBranch} 上，云端通道只在任务分支上执行。`);
  input = { ...input, cwd: worktree.path };

  const material = taskMaterial(input.commDir, input.prompt);
  const prompt = vendorPrompt(input, repo, material, worktree.readOnly);
  // 摘要必须覆盖定义本轮的全部输入：供应商 prompt 已含 task.md 与内联的复核意见，
  // 不能只取派工消息（复用 comm 目录时不同任务的派工消息可能逐字相同）。
  const digest = laneDigest(input.provider, prompt);
  // 当轮稳定投递键：claim.json 的 deliveryId 或环境变量传入；同一投递内正文重排/目录变化仍按同一回合恢复。
  const delivery = input.env.SCK_DELIVERY_ID?.trim() || input.env.SCK_DELIVERY_KEY?.trim() || readClaimDelivery(input.commDir) || undefined;
  const registryKey = delivery ?? digest;
  const sameRound = delivery !== undefined && state.delivery !== undefined ? state.delivery === delivery : state.digest === digest;
  const deadline = deps.now() + (input.config.maxMinutes ?? 180) * 60_000;

  // 相同投递（或旧状态没有投递键时的相同摘要）重连在途云端任务；新回合清空 taskId 但保留可复用的供应商会话（vendorSession）。
  const next: LaneState = { ...state, sessionId, digest, delivery, branch: repo.branch, task: readClaimTask(input.commDir) };
  // Devin 上一轮已按下发送（或发送中途进程中断，attempt 残留）且受理未确认、没有会话地址可核对：
  // 换了投递也不能另建会话（可能与在途会话重复），受阻交人工。在途登记与 attempt 原样保留。
  if (!sameRound && input.provider === 'devin-cloud' && (state.taskId || state.devin?.attempt)
    && !state.taskUrl && !state.vendorSession)
    return blocked(`上一轮 Devin Cloud 已按下发送（或发送中途中断）但未确认受理，且没有会话地址可核对；为避免另建重复会话，本轮未发出。在途登记已保留，请人工核对会话列表后再决定是否重派。`);
  if (!sameRound) {
    delete next.taskId; delete next.taskUrl; delete next.submittedAt;
    // 落点会话属于旧回合的发送，新回合不沿用；仍在途的旧发送由共享登记另行决定。
    if (next.devin) next.devin = { ...next.devin, attemptSession: undefined };
  }
  // 本 comm 目录没有在途任务时查共享登记：同一投递换员工实例也能重连，而不是重复提交云端任务。
  if (!next.taskId) {
    // 已受理与「已按下/已产出但未确认」的代跑回传意图可以共存（taskId 指原会话，attempt 指回传那一发）：
    // 恢复时两者都要带过来，只核对零重发，并复用已落盘的回传正文，不再次执行工具。
    const pendingDevin = (entry: Pick<InflightEntry, 'attempt' | 'attemptAt' | 'assistRounds' | 'assistRelay'>) => ({
      ...(entry.attempt ? { attempt: entry.attempt, attemptAt: entry.attemptAt } : {}),
      ...(entry.assistRounds !== undefined ? { assistRounds: entry.assistRounds } : {}),
      ...(entry.assistRelay ? { assistRelay: entry.assistRelay } : {}),
    });
    /** 明确写了别的公司任务的登记不属于本任务：绑定原任务是恢复的第一道。 */
    const bindsTask = (entry: InflightEntry) => entry.task === undefined || next.task === undefined || entry.task === next.task;
    const distinctBy = <T,>(rows: T[], key: (row: T) => string): T[] => {
      const seen = new Set<string>();
      return rows.filter(row => { const k = key(row); if (seen.has(k)) return false; seen.add(k); return true; });
    };
    // 摘要变了（返工改了 findings 等）时，同一公司任务的其它登记也要找：按任务与内容找，不看目录顺序。
    const others = next.task ? readInflightOfTask(input.stateRoot, input.provider, next.task, digest) : [];
    // 新键（投递）优先；升级前的登记仍按摘要查找。
    const reg = readInflight(input.stateRoot, input.provider, registryKey)
      ?? (registryKey !== digest ? readInflight(input.stateRoot, input.provider, digest) : undefined);
    // 未确认的发送意图（attempt）可能已经按下，优先级高于任何已受理快照。只按内容去重，不按文件顺序或
    // 提交时间挑：恰好一条可核对的意图才接管，多条互相冲突就受阻塞、零发送。
    const intents = input.provider === 'devin-cloud'
      ? distinctBy([...(reg?.attempt && bindsTask(reg) ? [reg] : []), ...others.filter(bindsTask)]
          .filter(entry => entry.attempt), entry => `${entry.attempt!}\n${entry.attemptSession ?? ''}`)
      : [];
    if (intents.length > 1)
      return blocked('同一任务存在多条互不相同的 Devin Cloud 未确认发送意图，无法判定哪一条属于当前会话；为避免重复发送，本轮未发出、未代跑。在途登记已保留，请人工核对后再决定是否重派。');
    const intent = intents[0];
    if (intent) {
      // 已落下发送意图但受理未确认：按在途处理，只核对是否已受理，绝不再次按发送。
      // 落点会话（续轮的原会话 / attemptSession）决定核对哪个会话；本目录其它会话地址不沿用。
      // 没有会话地址时：同一投递键仍可按标记在会话列表里找；跨投递/换摘要则直接受阻（避免另建）。
      const sameKey = Boolean(reg?.attempt && reg.attempt === intent.attempt
        && (reg.attemptSession ?? '') === (intent.attemptSession ?? ''));
      if (!intent.attemptSession && !intent.taskUrl && !intent.vendorSession && !sameKey)
        return blocked(`同一任务上一轮 Devin Cloud 已按下发送（或发送中途中断）但未确认受理，且没有会话地址可核对；换了摘要也不能另建会话（避免重复）。本轮未发出，在途登记已保留，请人工核对在途登记后再决定是否重派。`);
      // 已有 taskId（原会话已受理）或带代跑轮数/回传正文 → 这是代跑回传的未确认意图：把原会话地址
      // 一并带上，跳过会话列表搜寻，直接在原会话轮询并保留 attempt（只核对、零重发、不再代跑）。
      // 单纯的首发/续轮发送意图（只有 attempt、没有代跑痕迹）仍走会话列表/原会话核对，找到后继续。
      const assistPending = intent.assistRelay !== undefined || intent.assistRounds !== undefined
        || intent.taskId !== undefined;
      next.taskId = intent.taskId ?? intent.attempt!;
      next.submittedAt = intent.attemptAt ?? intent.submittedAt ?? next.submittedAt;
      if (assistPending) {
        const session = intent.attemptSession ?? intent.taskUrl ?? intent.vendorSession;
        if (session) { next.taskUrl = session; next.vendorSession = session; }
      }
      next.devin = { ...next.devin, attempt: intent.attempt!, attemptAt: intent.attemptAt,
        attemptSession: intent.attemptSession, ...pendingDevin(intent) };
    } else if (reg?.taskId && bindsTask(reg)) {
      next.taskId = reg.taskId;
      next.taskUrl = reg.taskUrl;
      next.submittedAt = reg.submittedAt;
      next.vendorSession ??= reg.vendorSession;
      if (input.provider === 'devin-cloud')
        next.devin = { ...next.devin, attemptSession: reg.attemptSession, ...pendingDevin(reg) };
    } else if (next.task) {
      // 摘要变了（返工改了 findings 等）：同一公司任务在别的目录里的登记仍代表已发出的会话，不能当成新任务另建。
      // 未确认受理且没有会话地址的只能受阻交人工核对；有会话地址的沿用它做跟进（同一会话，不另建）。
      const accepted = others.filter(entry => bindsTask(entry) && entry.taskId && inflightSession(entry));
      const sessions = new Set(accepted.map(entry => inflightSession(entry)!));
      if (sessions.size > 1)
        return blocked('同一任务存在多条 Devin Cloud 已受理记录且落点会话不一致，无法判定当前会话；为避免错发或另建重复会话，本轮未发出。在途登记已保留，请人工核对后再决定是否重派。');
      // 提交时间相同也要确定：先按提交时间，再按标记字符串，绝不依赖目录遍历顺序。
      const ordered = [...accepted].sort((a, b) =>
        (b.submittedAt ?? 0) - (a.submittedAt ?? 0) || (a.taskId! < b.taskId! ? -1 : a.taskId! > b.taskId! ? 1 : 0));
      const pending = !material.review && !material.findings ? ordered[0] : undefined;
      if (pending) {
        next.taskId = pending.taskId;
        next.taskUrl = pending.taskUrl ?? inflightSession(pending);
        next.submittedAt = pending.submittedAt;
        next.vendorSession = pending.vendorSession;
        if (pending.assistRounds !== undefined || pending.attempt || pending.assistRelay)
          next.devin = { ...next.devin, ...pendingDevin(pending) };
      } else if (input.provider === 'devin-cloud') {
        if (others.some(entry => !inflightSession(entry)))
          return blocked(`同一任务上一轮 Devin Cloud 已按下发送（或发送中途中断）但未确认受理，且没有会话地址可核对；换了摘要也不能另建会话（避免重复）。本轮未发出，在途登记已保留，请人工核对在途登记后再决定是否重派。`);
        const session = others.map(inflightSession).find(Boolean);
        if (session) next.vendorSession ??= session;
      }
    }
  }
  try {
    const outcome = await drive({ input, deps, repo, material, prompt, state: next, digest, key: registryKey, deadline, readOnly: worktree.readOnly });
    if (!outcome.inflight && (outcome.kind !== 'error' || outcome.vendorTerminal)) {
      // 完成、受阻、供应商终态失败：回合有了定论，清除登记并清掉在途任务标记（失败可重新提交）。
      // 仍在途的受阻（供应商会话已发出、等待核对）保留标记，恢复时不再发送。
      // 终态也清掉未确认的代跑回传意图与已产出正文，不把上一回合的发送意图带进下一回合。
      clearInflight(input.stateRoot, input.provider, registryKey);
      if (registryKey !== digest) clearInflight(input.stateRoot, input.provider, digest);
      clearSettledInflight(input.stateRoot, input.provider, next.task, next.taskId);
      const terminalDevin = next.devin
        ? { ...next.devin, attempt: undefined, attemptAt: undefined, attemptSession: undefined, assistRelay: undefined }
        : undefined;
      writeLaneState(input.commDir, { ...next, taskId: undefined, taskUrl: undefined, submittedAt: undefined,
        ...(outcome.vendorTerminal ? { vendorSession: undefined } : {}),
        ...(terminalDevin ? { devin: terminalDevin } : {}) });
    } else {
      writeLaneState(input.commDir, next);
      recordInflight(input.stateRoot, input.provider, registryKey, next);
    }
    if (outcome.kind === 'error') return fail(outcome.text);
    if (outcome.kind === 'blocked') return { sessionId, status: 'success', text: outcome.text.startsWith(BLOCKED) ? outcome.text : `${BLOCKED}\n${outcome.text}` };
    if (material.review && !REVIEW_PREFIX.test(outcome.text.trimStart()))
      return fail('云端复核答复首行不是「复核结论：通过/退回」，按协议不计为复核结果');
    return { sessionId, status: 'success', text: outcome.text };
  } catch (error) {
    writeLaneState(input.commDir, next);
    recordInflight(input.stateRoot, input.provider, registryKey, next);
    return fail((error as Error).message);
  }
}
