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
