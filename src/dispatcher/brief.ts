/**
 * What an employee is handed for one task: task.md (the requirement only) and, after a return, findings/round-NN.md
 * (the reviewer's words verbatim). The dispatch message then points at these files in three sentences.
 *
 * Company rules, role descriptions and protocol text stay out: the system enforces leases, worktrees, quota and
 * credentials, so restating them only buries the requirement. Pure: the sidecar writes the files.
 */
import type { ClaimResult, HistoryEntry, ProjectView, TaskView } from '../contracts.ts';

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

/** The requirement part of a task context. Delivery legs wrap it in a fixed head; anything else is kept whole. */
export function requirementOf(context: string): string {
  const legacy = /需求与验收标准：\n([\s\S]*?)\n\n项目环境（/.exec(context);
  return (legacy ? legacy[1]! : context).trim();
}

type Leg = 'implement' | 'release' | 'combined' | 'deploy' | undefined;
const legOf = ({ title = '' }: Partial<Pick<TaskView, 'title'>>): Leg =>
  title.endsWith(' · 实现与上线申请') ? 'combined'
    : title.endsWith(' · 实现') ? 'implement'
      : title.endsWith(' · 上线申请') ? 'release'
        : title.endsWith(' · 合入部署与生产实测') ? 'deploy' : undefined;

const RELEASE_ITEMS = 'PR 链接与提交、改动摘要、影响面、数据库迁移类型（无 / 只新增结构 / 改写或删除已有数据）、新环境变量或主机准备、回滚方式、生产验证要点';

/** This leg's own job, for the executor or the reviewer; undefined for tasks outside a delivery chain. */
function legJob(leg: Leg, review: boolean): string | undefined {
  if (!leg) return undefined;
  if (review) {
    return {
      implement: '读 diff、跑测试，确认实现满足上面的需求。',
      release: '决定是否上线：accept 即同意上线，return 写明还要补什么。',
      combined: '复核 PR 与上线材料，决定是否上线：accept 即同意上线，return 写明还要补什么。',
      deploy: '在生产环境按上面的需求逐条实测；测试账号、workspace、登录用 ops_* 工具（sck call ops_info \'{}\'）。每条写：入口 → 操作 → 实际结果。',
    }[leg];
  }
  return {
    implement: '实现上面的需求，推送分支并创建 PR（不要合入）。',
    release: `提交上线申请：${RELEASE_ITEMS}。`,
    combined: `实现上面的需求，推送分支并创建 PR（不要合入），并一并提交上线材料：${RELEASE_ITEMS}。`,
    deploy: '合入 PR，按下面的发布方式发布，核对生产运行的就是该提交；发布失败先回滚再修复。提交合入提交、发布运行链接与生产健康检查结果。',
  }[leg];
}

function releaseFacts(project: ProjectView | undefined): string | undefined {
  if (!project) return undefined;
  const lines = [`- 发布方式：${project.release}`];
  if (project.rollback) lines.push(`- 回滚：${project.rollback}`);
  for (const env of project.envs ?? []) if (env.url) lines.push(`- ${env.name}：${env.url}${env.healthUrl ? `（健康检查 ${env.healthUrl}）` : ''}`);
  return lines.join('\n');
}

/** task.md for this claim. */
export function taskBrief(claim: Pick<ClaimResult, 'task' | 'project'>): string {
  const review = claim.task.state === 'review';
  const leg = legOf(claim.task);
  const parts = [`# ${claim.task.title ?? ''}`, '', '## 需求', '', requirementOf(claim.task.context ?? '')];
  const job = legJob(leg, review);
  if (job) parts.push('', review ? '## 复核要点' : '## 本环节', '', job);
  if (leg === 'deploy') {
    const facts = releaseFacts(claim.project);
    if (facts) parts.push('', '## 发布与环境', '', facts);
  }
  return `${parts.join('\n')}\n`;
}
