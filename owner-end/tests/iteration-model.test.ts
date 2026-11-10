import { expect, test } from 'bun:test';
import { planRequirementWith } from '../src/iteration-planner.ts';
import { classifyFeedbackWith } from '../src/feedback-triage.ts';
import { iterationPlan } from '../../src/iteration/planning.ts';

const config = { baseUrl: 'https://model.example/v1', model: 'test', apiKey: 'test' };
const completion = (content: string) => (async () => Response.json({ choices: [{ message: { content } }] })) as unknown as typeof fetch;
const approval = { content: { title: '核对反馈', problem: '只读检查', acceptance: '记录结论', project: 'sample', priority: 2 } } as Parameters<ReturnType<typeof planRequirementWith>>[0];
const plan = { steps: [{ title: '检查反馈记录', context: '只读核对并验证关联', acceptance: '记录核对结论' }] };

test('规划支持完整 JSON 代码块，仍通过任务结构校验', async () => {
  const result = await planRequirementWith(config, completion('```json\n' + JSON.stringify(plan) + '\n```'))(approval);
  expect(iterationPlan(result)).toEqual(plan);
});
test('反馈整理接受纯 JSON 与完整代码块', async () => {
  const decision = { disposition: 'dismiss', category: 'noise', reason: '无诉求' };
  for (const body of [JSON.stringify(decision), '```\n' + JSON.stringify(decision) + '\n```']) {
    expect(await classifyFeedbackWith(config, completion(body))({ feedback: {} as never, candidates: [] })).toEqual(decision);
  }
});
test('不从说明文字或截断响应中猜测 JSON，错误不泄露模型正文', async () => {
  for (const body of ['private-model-body\n' + JSON.stringify(plan), '```json\n{"steps":[']) {
    const error = await planRequirementWith(config, completion(body))(approval).then(() => undefined, error => error);
    expect(error).toBeDefined();
    expect(String(error)).not.toContain('private-model-body');
  }
});
