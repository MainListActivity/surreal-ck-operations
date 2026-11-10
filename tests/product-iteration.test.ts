import { expect, test } from 'bun:test';
import { productPolicy, requirementContent } from '../src/iteration/requirements.ts';

test('需求内容有界，未确认草稿允许尚未填写验收标准', () => {
  expect(requirementContent({project:'sample', title:' 查找需求 ', problem:'用户无法检索历史', priority:1})).toEqual({project:'sample', title:'查找需求', problem:'用户无法检索历史', priority:1, acceptance:''});
  expect(() => requirementContent({project:'sample',title:'x',problem:'x',priority:NaN})).toThrow();
  expect(() => requirementContent({project:'sample',title:'x',problem:'x'.repeat(12001)})).toThrow();
});

test('GitHub 自动部署不需要二次授权；兼容旧策略快照且反馈只允许 HTTPS origin', () => {
  const base={enabled:true,autoRelease:false,feedbackOrigins:['https://product.example']};
  expect(productPolicy(base).autoRelease).toBe(false);
  expect(productPolicy({...base,autoRelease:undefined}).autoRelease).toBe(true);
  expect(productPolicy({...base,autoRelease:true}).releaseInstructions).toBe('');
  expect(() => productPolicy({...base,feedbackOrigins:['https://user:pass@product.example']})).toThrow();
  expect(() => productPolicy({...base,feedbackOrigins:['https://product.example/feedback']})).toThrow();
  expect(() => productPolicy({...base,feedbackOrigins:['*']})).toThrow();
  expect(productPolicy({...base,autoRelease:true,releaseInstructions:'流水线',verifyInstructions:'健康检查',rollbackInstructions:'恢复前版'}).autoRelease).toBe(true);
});

import { feedbackInput } from '../src/iteration/feedback.ts';
import { feedbackDecision } from '../src/iteration/triage.ts';
test('反馈 URL 不保留查询参数与片段，不接受其它产品来源',()=>{
  const input={requestKey:'request-123',text:'无法保存',page:'https://product.example/settings?token=private#secret'};
  expect(feedbackInput(input,'https://product.example').page).toBe('https://product.example/settings');
  expect(()=>feedbackInput(input,'https://other.example')).toThrow();
  expect(()=>feedbackInput({...input,text:'x'.repeat(6001)},'https://product.example')).toThrow();
});
test('整理模型只能关联给定候选，不能通过模型输出伪造批准',()=>{
  expect(()=>feedbackDecision({disposition:'approved',category:'bug',reason:'用户要求'},[])).toThrow();
  expect(()=>feedbackDecision({disposition:'existing',category:'bug',reason:'重复',requirementId:'foreign'},['local'])).toThrow();
  expect(feedbackDecision({disposition:'existing',category:'bug',reason:'重复',requirementId:'local'},['local']).requirementId).toBe('local');
});
test('模型逐条验收数组转为需求文本，拒绝对象与超长内容',()=>{
  const base={disposition:'new',category:'bug',reason:'需要修复',title:'主机统计',problem:'重复计算主机'};
  expect(feedbackDecision({...base,acceptance:[' 主机不重复 ', '离线员工仍可见']},[]).acceptance).toBe('主机不重复\n离线员工仍可见');
  expect(()=>feedbackDecision({...base,acceptance:[{text:'不能猜测对象语义'}]},[])).toThrow();
  expect(()=>feedbackDecision({...base,acceptance:['字'.repeat(3001)]},[])).toThrow();
  expect(()=>feedbackDecision({...base,acceptance:Array(31).fill('标准')},[])).toThrow();
});

import { iterationPlan } from '../src/iteration/planning.ts';
import { iterationMessages } from '../src/iteration/execution.ts';
import type { CreateTask } from '../src/contracts.ts';
test('计划限制任务数与内容长度，输出不会赋予模型任意角色或执行命令',()=>{
  const step={title:'实现检索',context:'实现检索与测试',acceptance:'准确返回结果',executorRole:'owner',command:'deploy'};
  expect(iterationPlan({steps:[step]}).steps[0]).toEqual({title:step.title,context:step.context,acceptance:step.acceptance});
  expect(()=>iterationPlan({steps:Array(7).fill(step)})).toThrow();
  expect(()=>iterationPlan({steps:[{...step,context:'x'.repeat(1001)}]})).toThrow();
});
test('迭代派工提交与发布分离，不继承旧模板的合入后提交行为',()=>{
  const base={workIntent:{kind:'code'}} as CreateTask;
  expect(iterationMessages(base).execute).toContain('不要合并 PR');
  expect(iterationMessages(base).review).toContain('不发布');
  const release=iterationMessages({...base,acceptanceEnvironment:'production'});
  expect(release.execute).toContain('真实部署提交');expect(release.review).toContain('在生产独立复测');
  expect(release.execute).toContain('无需二次老板审批');
  expect(release.execute).toContain('不得手工构建或部署');
});
