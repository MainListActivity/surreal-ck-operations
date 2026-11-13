/**
 * 云端员工通道核心：把公司回合（task.md + findings）翻译成供应商云端任务，等待终态，
 * 按公司收尾协议产出最终答复。所有外部交互（子进程、HTTP、时间）都经 LaneDeps 注入，
 * 测试可以完全不触网不碰 git 跑通各分支。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLaneProvider, type LaneProvider } from '../native-args.ts';
import { laneDigest, readLaneState, writeLaneState, type LaneState } from './state.ts';
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

/** 把 task.md 与派工消息点名的最新 findings 内联进供应商 prompt：云端 agent 读不到本机文件、也调不了 sck。 */
export function taskMaterial(commDir: string, prompt: string): { task: string; findings?: string; review: boolean; title: string } {
  let task = '';
  try { task = readFileSync(join(commDir, 'task.md'), 'utf8'); } catch { /* 无 task.md：少见，仍按 prompt 执行 */ }
  const review = task.includes(REVIEW_MARKER);
  const names = [...prompt.matchAll(/findings\/round-(\d+)\.md/g)].map(m => Number(m[1]));
  let findings: string | undefined;
  if (names.length) {
    const latest = Math.max(...names);
    const file = join(commDir, 'findings', `round-${String(latest).padStart(2, '0')}.md`);
    if (existsSync(file)) findings = readFileSync(file, 'utf8');
  }
  const title = (/^#\s+(.+)$/m.exec(task)?.[1] ?? task.split('\n').find(l => l.trim()) ?? '云端任务').trim().slice(0, 80);
  return { task, findings, review, title };
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
  if (material.findings !== undefined)
    parts.push('', '## 复核退回意见（逐条修复）', material.findings.trim());
  parts.push('', material.task.trim() || input.prompt.trim());
  return parts.join('\n');
}

interface VendorOutcome { kind: 'done' | 'blocked' | 'error'; text: string }

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

/** 一轮云端执行：识别仓库 → 组装 prompt → 提交或重连 → 收尾成公司协议文本。 */
export async function runLane(input: LaneInput, deps: LaneDeps): Promise<LaneOutcome> {
  const state = readLaneState(input.commDir) ?? { sessionId: `lane-${crypto.randomUUID()}` };
  const sessionId = input.resumeId ?? state.sessionId;
  const fail = (text: string): LaneOutcome => ({ sessionId, status: 'error', text });
  if (!isLaneProvider(input.provider)) return fail(`未知云端通道：${input.provider}`);

  const repo = await repoInfo(deps.exec, input.cwd).catch(() => undefined);
  if (!repo) return { sessionId, status: 'success', text: `${BLOCKED}：当前目录不是已关联 GitHub origin 的代码工作树，云端通道只承接代码任务。` };

  const material = taskMaterial(input.commDir, input.prompt);
  const prompt = vendorPrompt(input, repo, material);
  // 摘要必须覆盖定义本轮的全部输入：供应商 prompt 已含 task.md 与内联的复核意见，
  // 不能只取派工消息（复用 comm 目录时不同任务的派工消息可能逐字相同）。
  const digest = laneDigest(input.provider, prompt);
  const deadline = deps.now() + (input.config.maxMinutes ?? 180) * 60_000;

  // 相同 prompt 摘要重连在途云端任务；新回合清空 taskId 但保留可复用的供应商会话（vendorSession）。
  const next: LaneState = { ...state, sessionId, digest, branch: repo.branch };
  if (state.digest !== digest) { delete next.taskId; delete next.taskUrl; delete next.submittedAt; }
  try {
    const outcome = await drive({ input, deps, repo, material, prompt, state: next, digest, deadline });
    writeLaneState(input.commDir, outcome.kind === 'error' ? next : { ...next, taskId: undefined, taskUrl: undefined, submittedAt: undefined });
    if (outcome.kind === 'error') return fail(outcome.text);
    if (outcome.kind === 'blocked') return { sessionId, status: 'success', text: outcome.text.startsWith(BLOCKED) ? outcome.text : `${BLOCKED}：${outcome.text}` };
    if (material.review && !REVIEW_PREFIX.test(outcome.text.trimStart()))
      return fail('云端复核答复首行不是「复核结论：通过/退回」，按协议不计为复核结果');
    return { sessionId, status: 'success', text: outcome.text };
  } catch (error) {
    writeLaneState(input.commDir, next);
    return fail((error as Error).message);
  }
}
