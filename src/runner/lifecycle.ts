import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from '../comm.ts';
import type { Evidence, LeaseProof } from '../contracts.ts';
import type { TurnEnded } from './contracts.ts';

export type ResultAction = 'submit' | 'accept' | 'return' | 'block';
export interface WorkResult {
  action: ResultAction;
  evidence: Omit<Evidence, 'idempotencyKey'>;
}
export interface ExecutionAttempt {
  employee: string;
  agent?: string;
  task: string;
  proof: LeaseProof;
  phase: 'doing' | 'review';
  state: 'reserved' | 'running' | 'collecting' | 'pending' | 'settled' | 'interrupted' | 'superseded' | 'attention';
  turn?: string;
  startedAt?: number;
  createdAt?: number;
  turns: string[];
  result?: WorkResult;
  finalText?: string;
  /** 最近一次工作结论的取得方式：written 是员工按协议手写的首行口令，steward 是判读器给出的结构化结论。 */
  verdictVia?: 'written' | 'steward';
  /** 本任务已连续自动跟进的轮数：手写口令清零，判读器每次加一。 */
  autoFollowups?: number;
  providerFailure?: import('../dispatcher/provider-failover.ts').ProviderFailure['cause'];
  artifacts?: { raw?: string; blocker?: string; report?: string };
  prepared?: boolean;
  originalResult?: WorkResult;
  tries: number;
  nextRetry: number;
  error?: string;
  /** When the first CI wait of this result began. A wait past the executor's limit blocks the result instead of retrying forever. */
  ciWaitSince?: number;
  /** The last refusal text the core gave for this result; it is carried into the block reason when the result is blocked. */
  lastRefusal?: string;
  /** Why a result that can no longer be delivered was retired: the authoritative task/employee fact that disproved its lease. */
  supersededCause?: SupersededCause;
  supersededAt?: number;
  at: number;
}

/**
 * A pending result whose delivery no longer names the task's lease. The work itself is kept; only delivery stops.
 * These are facts about the task or the employee, never the text of a failed call: a transient auth or network
 * failure is not proof that the work is invalid.
 */
export type SupersededCause = 'task_finished' | 'task_missing' | 'task_not_active' | 'lease_replaced' | 'employee_gone';

/** Read-only facts used to decide whether a pending result can still be delivered. Absent fields are unknown. */
export interface ResultFacts {
  task?: { state: string; currentEmployee?: string; deliveryId?: string; fence?: number };
  /** `missing` means the employee row is gone, which is as final as retired or revoked. */
  employee?: { retired?: boolean; revoked?: boolean; missing?: boolean };
  /** The core already recorded this delivery's result under its idempotency key: the write committed even
   * though its reply was lost. Such a result was delivered; it is settled, never superseded. */
  landed?: boolean;
}

/** The frozen write whose fate a fact source is asked about: enough to find the exact stored transition. */
export interface ResultDeliveryRef {
  deliveryId: string;
  fence: number;
  action: ResultAction;
  idempotencyKey: string;
}
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new Error(message); };

/** Business output only. Proof, identity, task and idempotency are always supplied by the runner. */
export function workResult(text: string, phase: 'doing' | 'review', structured?: unknown): WorkResult {
  let summary = text.trim(), action: ResultAction = 'submit';
  const evidence: Omit<Evidence, 'idempotencyKey'> = { text: '' };
  if (structured !== undefined) {
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) fail('工作结果必须是对象');
    const value = structured as Record<string, unknown>;
    if (typeof value.summary !== 'string' || !value.summary.trim()) fail('工作结果缺少 summary');
    summary = value.summary as string;
    if (value.outcome !== undefined && !['completed', 'blocked'].includes(String(value.outcome))) fail('工作结果 outcome 无效');
    if (value.outcome === 'blocked') action = 'block';
    else if (phase === 'review') {
      if (value.review !== 'accept' && value.review !== 'return') fail('复核结果需要明确通过或退回');
      action = value.review as 'accept' | 'return';
    }
    if (value.sha !== undefined) {
      if (typeof value.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(value.sha)) fail('代码结果需要完整提交 SHA');
      evidence.sha = value.sha as string;
    }
    if (value.environment !== undefined) {
      if (typeof value.environment !== 'string' || !/^[a-z][a-z0-9._-]{0,49}$/.test(value.environment)) fail('发布环境名称无效');
      evidence.acceptance = { environment: value.environment as string };
    }
  } else {
    // Only an explicit leading business verdict counts; never infer a verdict from prose or quoted feedback.
    const heading = summary.split(/\r?\n/, 1)[0]!.replace(/[*#]/g, '').trim();
    if (/^工作结果[:：]\s*受阻\s*$/.test(heading)) action = 'block';
    else if (phase === 'review') {
      if (/^复核结论[:：]\s*通过\s*$/.test(heading)) action = 'accept';
      else if (/^复核结论[:：]\s*退回\s*$/.test(heading)) action = 'return';
      else fail('复核结果缺少明确的通过或退回结论');
    }
    const sha = /^提交[:：]\s*([a-f0-9]{40})\s*$/im.exec(summary)?.[1];
    if (sha) evidence.sha = sha;
  }
  if (!summary) fail('没有工作结果');
  // Full output remains in the private journal. The company evidence has a bounded summary.
  evidence.text = `执行端自动收集的工作结果：\n${summary}`.slice(0, 29000);
  return { action, evidence };
}

/**
 * 代码回合的提交 SHA：优先取答复里手写的「提交：<40位SHA>」；没有时从任务工作树读取分支相对基线真实前进的 HEAD。
 * 基线取远端默认分支（origin/HEAD，退而 origin/main、origin/master）的 merge-base：与基线相同或不在同一祖先链上的
 * HEAD 都不算前进，不能拿它冒充交付提交。基线不可判时不填 SHA。
 */
export interface WorktreeHeadProbe {
  (command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }>;
}

const validSha = (text: string): boolean => /^[a-f0-9]{40}$/i.test(text);

export async function advancedWorktreeHead(probe: WorktreeHeadProbe, dir: string, branch?: string): Promise<string | undefined> {
  const head = await probe('git', ['rev-parse', 'HEAD'], dir);
  if (head.code !== 0 || !validSha(head.stdout.trim())) return undefined;
  const sha = head.stdout.trim().toLowerCase();
  if (branch) {
    const current = await probe('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    if (current.code !== 0 || current.stdout.trim() !== branch) return undefined;
  }
  let base: string | undefined;
  const originHead = await probe('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
  if (originHead.code === 0) {
    const ref = originHead.stdout.trim();
    base = /^origin\//.test(ref) ? ref.slice('origin/'.length) : undefined;
  }
  if (!base) {
    for (const candidate of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
      const probed = await probe('git', ['rev-parse', '--verify', candidate], dir);
      if (probed.code === 0 && validSha(probed.stdout.trim())) { base = candidate.slice('refs/remotes/origin/'.length); break; }
    }
  }
  if (!base) return undefined;
  const mergeBase = await probe('git', ['merge-base', 'HEAD', `origin/${base}`], dir);
  if (mergeBase.code !== 0 || !validSha(mergeBase.stdout.trim())) return undefined;
  const baseSha = mergeBase.stdout.trim().toLowerCase();
  if (baseSha === sha) return undefined;
  const ancestor = await probe('git', ['merge-base', '--is-ancestor', baseSha, 'HEAD'], dir);
  return ancestor.code === 0 ? sha : undefined;
}

/** 同一任务连续自动跟进的上限：超过后执行端强制转受阻交老板，不再让判读器代为自动继续。 */
export const AUTO_FOLLOWUP_LIMIT = 3;

/** 判读器（总管）对没有首行口令的最终答复给出的结构化结论。 */
export interface StewardVerdict {
  action: ResultAction;
  /** 结论摘要；缺省取答复首段。 */
  summary?: string;
  /** 代码回合的交付提交（与答复里手写 SHA 同规则）。 */
  sha?: string;
  /** 发布环境（发布任务的结构化证据）。 */
  environment?: string;
}

/** 判读器输入：答复原文、阶段、任务/员工/投递身份，以及本任务当前已连续自动跟进的轮数。 */
export interface StewardVerdictInput {
  text: string;
  phase: 'doing' | 'review';
  task: string;
  employee: string;
  deliveryId: string;
  autoFollowups: number;
}

export type StewardVerdictResolver = (input: StewardVerdictInput) => Promise<StewardVerdict | undefined> | StewardVerdict | undefined;

export interface StewardVerdictResult {
  result: WorkResult;
  via: 'written' | 'steward';
  autoFollowups: number;
}

/** 结论口令已写明就照用；没有口令时交给判读器，但硬约束两件：执行轮不得由判读器直接判 accept，连续自动跟进不超过上限。 */
export async function stewardWorkResult(text: string, phase: 'doing' | 'review', structured: unknown, opts: {
  resolver?: StewardVerdictResolver;
  task: string;
  employee: string;
  deliveryId: string;
  autoFollowups: number;
}): Promise<StewardVerdictResult> {
  if (structured !== undefined || !opts.resolver) return { result: workResult(text, phase, structured), via: 'written', autoFollowups: 0 };
  const heading = text.trim().split(/\r?\n/, 1)[0]?.replace(/[*#]/g, '').trim() ?? '';
  const explicit = /^工作结果[:：]\s*受阻\s*$/.test(heading) || (phase === 'review'
    ? /^复核结论[:：]\s*(通过|退回)\s*$/.test(heading)
    : /^提交[:：]\s*[a-f0-9]{40}\s*$/im.test(text));
  if (explicit) return { result: workResult(text, phase, structured), via: 'written', autoFollowups: 0 };
  const next = opts.autoFollowups + 1;
  if (next > AUTO_FOLLOWUP_LIMIT) {
    return { result: workResult('', phase, { outcome: 'blocked', summary: `同一任务已连续自动跟进 ${AUTO_FOLLOWUP_LIMIT} 轮，判读器不再自动继续；执行端强制转受阻交老板核对，请确认任务方向后再恢复。` }),
      via: 'steward', autoFollowups: next };
  }
  const verdict = await opts.resolver({ text, phase, task: opts.task, employee: opts.employee, deliveryId: opts.deliveryId,
    autoFollowups: opts.autoFollowups });
  if (!verdict) return { result: workResult(text, phase), via: 'written', autoFollowups: opts.autoFollowups };
  if (verdict.action !== 'submit' && verdict.action !== 'accept' && verdict.action !== 'return' && verdict.action !== 'block')
    throw new Error('判读器结论无效：需要 submit、accept、return 或 block');
  // 独立复核是 accept 的唯一来源：执行轮只能 submit/block，复核轮只能 accept/return/block。
  if (phase === 'doing' && verdict.action !== 'submit' && verdict.action !== 'block')
    throw new Error('判读器不能越过独立复核直接将执行轮判为 accept');
  if (phase === 'review' && verdict.action !== 'accept' && verdict.action !== 'return' && verdict.action !== 'block')
    throw new Error('复核轮判读器只能给出 accept、return 或 block');
  const summary = verdict.summary?.trim() || text.split(/\r?\n/).find(line => line.trim())?.slice(0, 500) || text.trim();
  // 判读器摘要只是概括，复核要看原文（逐步证据、页面事实）：摘要后附「原始答复：」全文。
  // 原文为空或与摘要相同（trim 相等）时只写摘要；总长仍由 workResult 的 29000 截断兜底。
  const original = text.trim();
  const fullSummary = original && original !== summary ? `${summary}\n\n原始答复：\n${original}` : summary;
  const value: Record<string, unknown> = { summary: fullSummary };
  if (verdict.action === 'block') value.outcome = 'blocked';
  else if (phase === 'review') {
    if (verdict.action === 'accept') value.review = 'accept';
    else if (verdict.action === 'return') value.review = 'return';
  }
  if (verdict.sha !== undefined) value.sha = verdict.sha;
  if (verdict.environment !== undefined) value.environment = verdict.environment;
  return { result: workResult('', phase, value), via: 'steward', autoFollowups: next };
}

export function finalAnswer(event: TurnEnded): string {
  // Paseo may include intermediate assistant messages; only the last non-empty assistant response is a result.
  let lastUser = -1;
  event.timeline.forEach((item, index) => { if (item.type === 'user_message') lastUser = index; });
  return event.timeline.slice(lastUser + 1).filter(item => item.type === 'assistant_message' && typeof item.text === 'string' && item.text.trim())
    .at(-1)?.text ?? '';
}

/** Durable outbox. A receipt is saved by atomic rename before any task transition is attempted. */
export class ExecutionJournal {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  private path(employee: string, delivery: string) { return join(this.root, `${key(`${employee}:${delivery}`)}.json`); }
  read(employee: string, delivery: string): ExecutionAttempt | undefined {
    return readJsonFile<ExecutionAttempt>(this.path(employee, delivery));
  }
  save(row: ExecutionAttempt): void {
    row.at = Date.now();
    const path = this.path(row.employee, row.proof.deliveryId), temp = `${path}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(row)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  }
  reserve(employee: string, phase: 'doing' | 'review', proof: LeaseProof): ExecutionAttempt {
    const prior = this.read(employee, proof.deliveryId);
    if (prior) return prior;
    const row: ExecutionAttempt = { employee, task: proof.taskId, phase, proof: { ...proof }, state: 'reserved',
      turns: [], tries: 0, nextRetry: 0, at: Date.now(), createdAt: Date.now() };
    this.save(row); return row;
  }
  rows(): ExecutionAttempt[] {
    return readdirSync(this.root).filter(name => name.endsWith('.json')).flatMap(name => {
      const row = readJsonFile<ExecutionAttempt>(join(this.root, name));
      return row && row.employee && row.proof && Array.isArray(row.turns) ? [row] : [];
    });
  }
  evidence(row: ExecutionAttempt): Evidence {
    if (!row.result) throw new Error('工作结果尚未收集');
    return { ...row.result.evidence, idempotencyKey: `runner-result:${key(`${row.employee}:${row.proof.deliveryId}:${JSON.stringify(row.result)}:${row.proof.expectedVersion}`)}` };
  }
}
