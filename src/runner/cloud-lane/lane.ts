/**
 * 云端员工通道核心：把公司回合（task.md + findings）翻译成供应商云端任务，等待终态，
 * 按公司收尾协议产出最终答复。所有外部交互（子进程、HTTP、时间）都经 LaneDeps 注入，
 * 测试可以完全不触网不碰 git 跑通各分支。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isLaneProvider, type LaneProvider } from '../native-args.ts';
import { clearInflight, laneDigest, readInflight, readLaneState, recordInflight, writeLaneState, type LaneState } from './state.ts';
import { repoInfo, type ExecFn, type RepoInfo } from './repo.ts';
import { driveCodex } from './codex.ts';
import { driveDevin } from './devin.ts';
import { driveJules } from './jules.ts';

export { isLaneProvider, type LaneProvider };

export interface LaneConfig {
  /** codex-cloud：owner/repo → 云端环境 ID 或环境标签（缺省用仓库名）。 */
  environments?: Record<string, string>;
  /** jules：24 小时内公司创建的会话上限（额度观察用）。 */
  dailyLimit?: number;
  /** jules：同时在途会话上限，超出按受阻处理。 */
  maxConcurrent?: number;
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
      throw new Error('原生执行端 lanes 配置无效：只允许 codex-cloud、devin-cloud、jules、warp、grok-bot、muse-web');
    for (const [key, value] of Object.entries(lane as Record<string, unknown>)) {
      if (key === 'environments') {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.entries(value as Record<string, unknown>).some(([repo, env]) => !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof env !== 'string' || !env))
          throw new Error(`lanes.${provider}.environments 必须是 "owner/repo" → 环境 ID/标签 的映射`);
      } else if (key === 'bin') {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.entries(value as Record<string, unknown>).some(([name, path]) => !/^[a-zA-Z0-9._-]+$/.test(name) || typeof path !== 'string' || !isAbsolute(path)))
          throw new Error(`lanes.${provider}.bin 必须是命令名 → 绝对路径 的映射`);
      } else if (!['dailyLimit', 'maxConcurrent', 'maxMinutes', 'pollMs'].includes(key) || typeof value !== 'number' || !(value > 0))
        throw new Error(`lanes.${provider}.${key} 必须是正数`);
      if (provider === 'warp' && !['bin', 'maxMinutes'].includes(key))
        throw new Error(`lanes.warp 只接受 bin 与 maxMinutes，收到 ${key}`);
      if ((provider === 'grok-bot' || provider === 'muse-web') && !['bin', 'maxMinutes', 'pollMs'].includes(key))
        throw new Error(`lanes.${provider} 只接受 bin、maxMinutes 与 pollMs，收到 ${key}`);
    }
  }
}

export interface LaneDeps {
  exec: ExecFn;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** 每步进展以 lane_status 事件输出给执行端活动流。 */
  progress(status: string): void;
}

export interface LaneInput {
  provider: LaneProvider;
  /** 派工消息原文（指向 task.md / findings 的三句话）。 */
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

const BLOCKED = '工作结果：受阻';

/** 复核轮：task.md 含待复核成果段。最终答复首行必须是复核结论，缺了按错误回合处理。 */
const REVIEW_MARKER = '## 待复核成果';
const REVIEW_PREFIX = /^复核结论：(通过|退回)/;

/**
 * 把 task.md 与最新 findings 内联进供应商 prompt：云端 agent 读不到本机文件、也调不了 sck。
 * findings 按通信目录里实际有的文件取，不看派工消息的措辞：领取时旧任务的 findings 已清掉（sidecar stageBrief），
 * 目录里有文件就是本任务最近一次退回；老板把消息改成什么样，退回意见都不会丢。复核轮不带。
 */
export function taskMaterial(commDir: string, _prompt?: string): { task: string; findings?: string; answer?: string; review: boolean; title: string } {
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
  return { task, findings, answer, review, title };
}

/** 交给云端 agent 的完整 prompt。 */
export function vendorPrompt(input: LaneInput, repo: RepoInfo, material: ReturnType<typeof taskMaterial>): string {
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
    if (input.provider === 'devin-cloud')
      parts.push('完成后确保远端分支上有提交、已开或更新一条到目标分支的 PR，最终答复末尾单独成行给出 `PR: <url>` 和 `SHA: <提交sha>`。');
    if (input.provider === 'codex-cloud')
      parts.push('工作结果由本地桥接进程应用与提交；只需把改动做完整。没有可交付的代码改动时，在最终消息里说明原因。');
  }
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
}

/** 按供应商分派；返回该轮最终答复文本与性质。 */
async function drive(ctx: {
  input: LaneInput; deps: LaneDeps; repo: RepoInfo;
  material: ReturnType<typeof taskMaterial>; prompt: string;
  state: LaneState; digest: string; deadline: number;
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
export function claimWorktree(commDir: string): { path: string; branch: string } | { blocked: string } {
  let claim: { worktree?: { worktreePath?: unknown; branch?: unknown } } | undefined;
  try { claim = JSON.parse(readFileSync(join(commDir, 'claim.json'), 'utf8')); } catch { /* 缺 claim.json */ }
  const worktree = claim?.worktree;
  const path = typeof worktree?.worktreePath === 'string' ? worktree.worktreePath : undefined;
  const branch = typeof worktree?.branch === 'string' && worktree.branch.trim() ? worktree.branch.trim() : undefined;
  if (!path || !isAbsolute(path) || !existsSync(path) || !branch)
    return { blocked: '本次派工没有可用的任务工作树（claim.json 未给出存在的 worktreePath 与分支）' };
  return { path, branch };
}

/** 一轮云端执行：识别仓库 → 组装 prompt → 提交或重连 → 收尾成公司协议文本。 */
export async function runLane(input: LaneInput, deps: LaneDeps): Promise<LaneOutcome> {
  const state = readLaneState(input.commDir) ?? { sessionId: `lane-${crypto.randomUUID()}` };
  const sessionId = input.resumeId ?? state.sessionId;
  const fail = (text: string): LaneOutcome => ({ sessionId, status: 'error', text });
  const blocked = (text: string): LaneOutcome => ({ sessionId, status: 'success', text: `${BLOCKED}：${text}` });
  if (!isLaneProvider(input.provider)) return fail(`未知云端通道：${input.provider}`);
  if (input.provider === 'warp') return fail('warp 走本地桥接进程（src/runner/warp/main.ts），不经云端通道');
  if (input.provider === 'grok-bot' || input.provider === 'muse-web') return fail(`${input.provider} 走网页桥接进程（src/runner/grok-bot/main.ts），不经云端通道`);

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
  const prompt = vendorPrompt(input, repo, material);
  // 摘要必须覆盖定义本轮的全部输入：供应商 prompt 已含 task.md 与内联的复核意见，
  // 不能只取派工消息（复用 comm 目录时不同任务的派工消息可能逐字相同）。
  const digest = laneDigest(input.provider, prompt);
  const deadline = deps.now() + (input.config.maxMinutes ?? 180) * 60_000;

  // 相同 prompt 摘要重连在途云端任务；新回合清空 taskId 但保留可复用的供应商会话（vendorSession）。
  const next: LaneState = { ...state, sessionId, digest, branch: repo.branch };
  if (state.digest !== digest) { delete next.taskId; delete next.taskUrl; delete next.submittedAt; }
  // 本 comm 目录没有在途任务时查共享登记：同一公司任务换员工实例也能重连，而不是重复提交云端任务。
  if (!next.taskId) {
    const reg = readInflight(input.stateRoot, input.provider, digest);
    if (reg) {
      next.taskId = reg.taskId;
      next.taskUrl = reg.taskUrl;
      next.submittedAt = reg.submittedAt;
      next.vendorSession ??= reg.vendorSession;
    }
  }
  try {
    const outcome = await drive({ input, deps, repo, material, prompt, state: next, digest, deadline });
    if (outcome.kind !== 'error' || outcome.vendorTerminal) {
      // 完成、受阻、供应商终态失败：回合有了定论，清除登记并清掉在途任务标记（失败可重新提交）。
      clearInflight(input.stateRoot, input.provider, digest);
      writeLaneState(input.commDir, { ...next, taskId: undefined, taskUrl: undefined, submittedAt: undefined,
        ...(outcome.vendorTerminal ? { vendorSession: undefined } : {}) });
    } else {
      writeLaneState(input.commDir, next);
      recordInflight(input.stateRoot, input.provider, digest, next);
    }
    if (outcome.kind === 'error') return fail(outcome.text);
    if (outcome.kind === 'blocked') return { sessionId, status: 'success', text: outcome.text.startsWith(BLOCKED) ? outcome.text : `${BLOCKED}：${outcome.text}` };
    if (material.review && !REVIEW_PREFIX.test(outcome.text.trimStart()))
      return fail('云端复核答复首行不是「复核结论：通过/退回」，按协议不计为复核结果');
    return { sessionId, status: 'success', text: outcome.text };
  } catch (error) {
    writeLaneState(input.commDir, next);
    recordInflight(input.stateRoot, input.provider, digest, next);
    return fail((error as Error).message);
  }
}
