import type { GoalTier, GoalView } from '../contracts.ts';
import { GOAL_TIERS, TIER_CRITERIA } from '../flows.ts';
import type { JudgeInput } from '../workforce.ts';
import type { JevClient } from './jev.ts';

/** Only these reach the owner; everything else is decided inside the company. */
export const OWNER_ONLY = [
  '花钱：充值、新增付费服务或订阅',
  '签约或其他法律承诺',
  '以公司名义对外联系客户、合作方或监管',
  '公司方向与大目标的取舍',
  '项目环境里登记的红线',
];

export async function jevTriage(jev: JevClient, goal: GoalView): Promise<{ tier?: GoalTier; confidence: number }> {
  const { answers } = await jev.ask(
    { goal: { title: goal.title, brief: goal.brief.slice(0, 8000), project: goal.project } },
    { tier: { type: 'choice', instructions: '这个老板目标应该走哪种交付流程？', criteria: TIER_CRITERIA } });
  const answer = answers.tier;
  const tier = GOAL_TIERS.find(t => t === answer?.choice);
  return { tier, confidence: answer?.confidence ?? 0 };
}

export async function jevRelease(jev: JevClient, input: JudgeInput): Promise<{ go: number; redLine: number }> {
  const { answers } = await jev.ask(
    { releaseRequest: input, ownerOnly: OWNER_ONLY },
    {
      go: { type: 'noul', instructions: '这份上线申请信息完整（PR 已复核、迁移类型与回滚方式写明）、风险可控，可以直接合入并发布到生产吗？' },
      red_line: { type: 'noul', instructions: '这次上线是否触碰 project.redLines 或 ownerOnly 中任一项（例如改写/删除已有数据的迁移、需要花钱或对外联系）？' },
    });
  return { go: answers.go?.noul ?? 0, redLine: answers.red_line?.noul ?? 1 };
}

export async function jevNeedsOwner(jev: JevClient, input: JudgeInput): Promise<number> {
  const { answers } = await jev.ask(
    { escalation: input, ownerOnly: OWNER_ONLY },
    { needs_owner: { type: 'noul', instructions: '这个问题是否只有老板本人才能决定（属于 ownerOnly 中的事项）？技术方案、拆分、是否上线、查得到的事实都不属于。' } });
  return answers.needs_owner?.noul ?? 1;
}

export interface RouteCandidate {
  /** 复用现有实例为 employee id，新开会话为 `spawn:<defId>`。 */
  key: string;
  kind: 'reuse' | 'spawn';
  provider: string;
  model: string;
  /** 该 def 的绩效均分与评分次数（0 次视为无记录）。 */
  score?: number;
  scored?: number;
  quota?: string;
  health?: string;
  continued?: boolean;
  /** Claimed this task before but never submitted — independent enough, but prefer clean candidates. */
  prior?: boolean;
}

export interface RouteInput {
  purpose: string;
  task?: { id: string; title: string; kind: string; state: string; project?: string; context?: string };
  candidates: RouteCandidate[];
  directions?: string[];
}

const describe = (c: RouteCandidate): string => {
  const bits = [c.kind === 'reuse' ? (c.continued ? '继续之前持有人的会话' : '复用现有会话') : '新开一个会话',
    c.prior ? '曾持有本任务但未提交（经手人）' : undefined,
    `${c.provider}/${c.model}`,
    c.scored ? `绩效均分 ${c.score?.toFixed(1)}/5（${c.scored} 次）` : '暂无绩效记录',
    c.quota ? `额度：${c.quota}` : '额度未知',
    c.health && c.health !== 'ok' ? `订阅状态 ${c.health}` : undefined].filter(Boolean);
  return bits.join(' · ');
};

/**
/**
 * 在已经通过硬约束（角色/项目/容量/不自审）的候选人中选一个。
 * 返回选中 key 与置信度；置信度由调用方对照 jevPickConfidence 决定是否采信。
 */
export async function jevStaff(jev: JevClient, input: RouteInput): Promise<{ key?: string; confidence: number }> {
  const { answers } = await jev.ask(
    {
      dispatch: {
        purpose: input.purpose,
        task: input.task ? { ...input.task, context: input.task.context?.slice(0, 2000) } : undefined,
        candidates: Object.fromEntries(input.candidates.map(c => [c.key, describe(c)])),
        companyDirections: input.directions?.slice(0, 5),
      },
    },
    {
      pick: {
        type: 'choice',
        instructions: '给这项派工选择最合适的员工：看任务类型与难度、该员工的绩效记录、订阅剩余额度和健康度；' +
          '复用会话保留上下文成本低，新开会话则在候选人更可靠或需要新实例时才值得。选不出时挑额度最宽裕的。',
        criteria: Object.fromEntries(input.candidates.map(c => [c.key, describe(c)])),
      },
    });
  const answer = answers.pick;
  return { key: answer?.choice, confidence: answer?.confidence ?? 0 };
}
