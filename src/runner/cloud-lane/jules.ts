/**
 * Jules 通道驱动：Jules REST API v1alpha（X-Goog-Api-Key 由执行端从 private/lanes/jules.env 注入）。
 * 首轮创建会话（sourceContext + startingBranch + AUTO_CREATE_PR，方案自动批准）→ 轮询 state →
 * COMPLETED 时取 outputs.pullRequest 并快进本地工作树；AWAITING_* 按受阻收尾（把 Jules 的问题带回来）；
 * 续轮（已有 vendorSession）走 :sendMessage。公司创建的会话时间记到 stateRoot/jules-usage.json 供额度观察。
 * 依据：https://developers.google.com/jules/api ；本实现只按文档与替身测试，未做真实联调。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAndFastForward, type RepoInfo } from './repo.ts';
import type { LaneDeps, LaneInput } from './lane.ts';
import { writeLaneState, type LaneState } from './state.ts';

const BASE = 'https://jules.googleapis.com/v1alpha';
const WAITING = new Set(['AWAITING_USER_FEEDBACK', 'AWAITING_PLAN_APPROVAL']);
const DONE = 'COMPLETED';

interface Ctx {
  input: LaneInput; deps: LaneDeps; repo: RepoInfo;
  material: { task: string; findings?: string; review: boolean; title: string };
  prompt: string; state: LaneState;
  digest: string; deadline: number;
}

async function api(deps: LaneDeps, key: string, path: string, init?: RequestInit): Promise<any> {
  const r = await deps.fetch(`${BASE}/${path}`, {
    ...init,
    headers: { 'X-Goog-Api-Key': key, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = await r.json().catch(() => undefined);
  if (!r.ok) {
    const message = (body as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${r.status}`;
    throw new Error(`Jules API ${r.status}：${message}`);
  }
  return body;
}

/** 追加一次会话创建时间；run.ts 的额度读取按 24 小时窗口计数。 */
export function recordJulesUsage(stateRoot: string | undefined, now: number): void {
  if (!stateRoot) return;
  const file = join(stateRoot, 'jules-usage.json');
  let entries: number[] = [];
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(value)) entries = value.filter((v): v is number => typeof v === 'number');
  } catch { /* 缺失或损坏都从新计数开始 */ }
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify([...entries, now]), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Jules 最新一条 agent 文本，取不到返回空。 */
function lastAgentText(activities: any): string {
  const list = Array.isArray(activities?.activities) ? activities.activities : [];
  for (const a of [...list].reverse()) {
    if (a?.originator !== 'agent') continue;
    const text = a?.sessionResult?.message ?? a?.agentMessaged?.agentMessage ?? a?.progressUpdated?.description ?? a?.progressUpdated?.title;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

export async function driveJules(ctx: Ctx): Promise<{ kind: 'done' | 'blocked' | 'error'; text: string }> {
  const { input, deps, repo, material, prompt, state } = ctx;
  const key = input.env.JULES_API_KEY?.trim();
  if (!key) throw new Error('缺少 JULES_API_KEY：请在 <service>/private/lanes/jules.env 配置后重启执行端');

  let name = state.taskId ?? state.vendorSession;
  if (state.taskId) deps.progress(`重连 Jules 会话 ${name}`);
  else if (state.vendorSession) {
    await api(deps, key, `sessions/${name!.replace(/^sessions\//, '')}:sendMessage`, { method: 'POST', body: JSON.stringify({ prompt }) });
    deps.progress(`已向 Jules 会话 ${name} 补充新指令`);
  } else {
    const created = await api(deps, key, 'sessions', { method: 'POST', body: JSON.stringify({
      prompt, title: material.title,
      sourceContext: { source: `sources/github/${repo.slug}`, githubRepoContext: { startingBranch: repo.branch } },
      automationMode: 'AUTO_CREATE_PR', requirePlanApproval: false,
    }) });
    name = created?.name;
    if (typeof name !== 'string' || !name) throw new Error('Jules 创建会话返回里没有会话名');
    recordJulesUsage(input.stateRoot, deps.now());
    deps.progress(`已提交 Jules 会话 ${name}`);
  }
  state.taskId = name; state.vendorSession = name;
  state.taskUrl = `https://jules.google.com/session/${name!.split('/').pop()}`;
  state.submittedAt = state.submittedAt ?? deps.now();
  writeLaneState(input.commDir, state);

  const sessionName = name!.replace(/^sessions\//, '');
  let session: any;
  for (;;) {
    session = await api(deps, key, `sessions/${sessionName}`);
    const s = String(session?.state ?? '');
    if (s === DONE || s === 'FAILED' || WAITING.has(s)) break;
    if (deps.now() > ctx.deadline)
      return { kind: 'error', text: `Jules 会话超时仍未结束（${name}，最近状态 ${s || '未知'}）；它可能仍在运行，请人工核对后再重试。` };
    deps.progress(`云端运行中：${s || '等待会话状态'}`);
    await deps.sleep(input.config.pollMs ?? 25_000);
  }

  const lastState = String(session?.state ?? '');
  const activities = () => api(deps, key, `sessions/${sessionName}/activities?pageSize=30`).catch(() => undefined);
  if (WAITING.has(lastState)) {
    const question = lastAgentText(await activities());
    return { kind: 'blocked', text: `Jules 会话等待人工输入（${lastState}）${question ? `：${question}` : ''}。会话：${name}` };
  }
  if (lastState === 'FAILED') return { kind: 'error', text: `Jules 会话失败（${name}）` };

  if (material.review) {
    const text = lastAgentText(await activities());
    if (!text) return { kind: 'error', text: `Jules 复核会话结束但取不到答复文本（${name}）` };
    return { kind: 'done', text };
  }

  const prUrl = (session?.outputs ?? []).map((o: any) => o?.pullRequest?.url).find(Boolean);
  try {
    const head = await fetchAndFastForward(deps.exec, input.cwd, repo.branch);
    const lines = [`Jules 会话完成：${name}`];
    if (prUrl) lines.push(`PR: ${prUrl}`);
    lines.push(`SHA: ${head}`);
    return { kind: 'done', text: lines.join('\n') };
  } catch (error) {
    if (!prUrl) return { kind: 'blocked', text: `Jules 会话完成但没有可快取的改动或 PR（${name}）。` };
    return { kind: 'error', text: (error as Error).message };
  }
}
