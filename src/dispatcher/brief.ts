/**
 * What an employee is handed for one task: task.md (requirement and, for review, the submitted result) and, after a return, findings/round-NN.md
 * (the reviewer's words verbatim). The dispatch message then points at these files in three sentences.
 *
 * Company rules, role descriptions and protocol text stay out: the system enforces leases, worktrees, quota and
 * credentials, so restating them only buries the requirement. Pure: the sidecar writes the files.
 */
import type { ClaimResult, HistoryEntry } from '../contracts.ts';

/** Returns that send work back to its author: a reviewer's return and an owner's reject. */
const RETURNS = new Set(['return', 'owner_reject']);

export interface Findings { round: number; file: string; text: string }

/** The newest return in the claim's history, numbered by how many returns the task has had. */
export function latestFindings(history: readonly HistoryEntry[] | undefined): Findings | undefined {
  const returns = (history ?? []).filter(entry => RETURNS.has(entry.action) && entry.evidence?.trim());
  const last = returns.at(-1);
  if (!last) return undefined;
  const round = returns.length;
  const cut = last.evidenceTruncated ? `\n\n（原文过长已截断；全文：sck call read_task_text '{"auditId":"${last.auditId ?? ''}"}'）` : '';
  return { round, file: `findings/round-${String(round).padStart(2, '0')}.md`, text: `${last.evidence!.trim()}${cut}\n` };
}

/** Results that consume an owner answer: once the work moved on, the answer is history, not something to hand over again. */
const ANSWER_CONSUMED = new Set(['submit', 'owner_submit', 'return', 'accept', 'owner_reject', 'owner_approve']);
/** The runner's and the owner desk's fixed heads on stored evidence; the employee and the owner wrote what follows. */
const stripHead = (text: string) => text.replace(/^执行端自动收集的工作结果：\n/, '').replace(/^工作结果[:：]\s*受阻\s*\n?/, '')
  .replace(/^来源：[^\n]*\n决定：reply\n?/, '').trim();

/**
 * The owner's answer to the newest block, while no work result has followed it. Before this, an owner reply only put the task back
 * in its phase: the employee was sent the same message again and never read the answer. Pure, over the handover history.
 */
export function latestAnswer(history: readonly HistoryEntry[] | undefined): { blocker?: string; reply: string } | undefined {
  let blocker: string | undefined, answer: { blocker?: string; reply: string } | undefined;
  for (const entry of history ?? []) {
    if (entry.action === 'block') { blocker = stripHead(entry.evidence ?? '') || undefined; answer = undefined; }
    else if (entry.action === 'owner_reply') { const reply = stripHead(entry.evidence ?? ''); answer = reply ? { blocker, reply } : undefined; }
    else if (ANSWER_CONSUMED.has(entry.action)) { blocker = undefined; answer = undefined; }
  }
  return answer;
}

/** answer.md: the block and the owner's answer verbatim, for an answer too long to inline and for lanes that only read files. */
export function answerFile(answer: { blocker?: string; reply: string }): string {
  return `${answer.blocker ? `## 上一轮受阻\n\n${answer.blocker}\n\n` : ''}## 老板答复\n\n${answer.reply}\n`;
}

/** Acceptance amendments are appended to the end of a task's context (core.taskAcceptanceAmend). */
const AMENDMENT_HEAD = '【验收要求修订';

/** The requirement part of a task context. Delivery legs wrap it in a fixed head; anything else is kept whole. The
 *  amendments appended after that head are part of the requirement, so the tail from the first one is kept verbatim. */
export function requirementOf(context: string): string {
  const legacy = /需求与验收标准：\n([\s\S]*?)\n\n项目环境（/.exec(context);
  if (!legacy) return context.trim();
  const amended = context.indexOf(AMENDMENT_HEAD);
  return [legacy[1]!.trim(), amended < 0 ? '' : context.slice(amended).trim()].filter(Boolean).join('\n\n');
}

/** task.md includes the current submitted result for review; gathering it is the runner's job. */
export function taskBrief(claim: Pick<ClaimResult, 'task' | 'project'> & Partial<Pick<ClaimResult, 'history'>> & { task: { requirement?: string; acceptanceText?: string; resources?: string } }): string {
  const task = claim.task as typeof claim.task & { requirement?: string; acceptance_text?: string; acceptanceText?: string; resources?: string };
  const parts = [`# ${task.title ?? ''}`, '', '## 需求', '', task.requirement?.trim() || requirementOf(task.context ?? '')];
  // 云端与网页通道只读得到 task.md，“可以用什么”必须也在这里。
  if (task.resources?.trim()) parts.push('', '## 可以用', '', task.resources.trim());
  const acceptance = task.acceptanceText?.trim() || task.acceptance_text?.trim();
  if (acceptance) parts.push('', '## 验收标准', '', acceptance);
  if (task.state === 'review') {
    const submitted = claim.history?.filter(entry => entry.action === 'submit' || entry.action === 'owner_submit').at(-1);
    parts.push('', '## 待复核成果', '');
    if (!submitted?.evidence?.trim()) {
      parts.push('执行端未取得提交成果；当前交接不完整。');
    } else {
      parts.push(`提交者：${submitted.actor}；提交时间：${submitted.at}`, '');
      if (submitted.evidenceTruncated) parts.push('提交成果不完整：以下仅为片段，不能据此完成复核。', '');
      parts.push(submitted.evidence);
    }
  }
  return `${parts.join('\n')}\n`;
}
