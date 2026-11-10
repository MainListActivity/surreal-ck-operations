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
  artifacts?: { raw?: string; blocker?: string; report?: string };
  prepared?: boolean;
  originalResult?: WorkResult;
  tries: number;
  nextRetry: number;
  error?: string;
  at: number;
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
