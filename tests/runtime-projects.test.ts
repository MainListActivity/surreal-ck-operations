import { expect, test } from 'bun:test';
import { buildProjectRooms, employeeProgress } from '../src/runtime-projects.ts';
import type { RuntimeAgentView } from '../src/runtime-dashboard.ts';
import type { PhaseDuration } from '../src/runtime-timing.ts';

const agent = (values: Partial<RuntimeAgentView> = {}): RuntimeAgentView => ({
  id:'dev', name:'开发', role:'engineering', hostId:'mac', state:'running', modelSource:'unknown', ...values,
});
const rooms = (values: Partial<Parameters<typeof buildProjectRooms>[0]> = {}) => buildProjectRooms({
  projects:[{id:'project:app', name:'产品'}], tasks:[], agents:[], messages:[], history:[], ...values,
});

test('无任务归属但运行或异常的员工仍有公共事务房；空闲员工不建空房', () => {
  expect(rooms({agents:[agent()]}).map(r=>r.id)).toContain('company-unassigned');
  expect(rooms({agents:[agent({state:'error'})]}).map(r=>r.id)).toContain('company-unassigned');
  expect(rooms({agents:[agent({state:'idle'})]}).map(r=>r.id)).not.toContain('company-unassigned');
});

test('确认计划的未创建步骤进入分母；未过复核的后继提议不算已确认范围', () => {
  const [room] = rooms({
    tasks:[{id:'one',project_ref:'app',state:'done'},{id:'proposal',project_ref:'app',state:'planned',proposed_in:'submission'}],
    requirements:[{id:'r',project:'app',approved_revision:2,state:'implementing'}],
    plans:[{requirement:'r',revision:2,body:JSON.stringify({steps:[{},{}]})}],
    executions:[{requirement:'r',revision:2,tasks:['one']}],
  });
  expect(room?.progress).toMatchObject({done:1,total:4,percent:25});
  expect(room?.queued).toBe(3);
  expect(room?.estimate.status).toBe('unavailable');
});

test('尚未拆解的已确认需求不能伪报项目100%；暂停和作废执行链明确阻塞ETA', () => {
  const input = {tasks:[{id:'done',project_ref:'app',state:'done'}],
    requirements:[{id:'r',project:'app',approved_revision:1,state:'implementing'}]};
  expect(rooms(input)[0]?.progress.percent).toBeUndefined();
  const plan = {requirement:'r',revision:1,body:JSON.stringify({steps:[{}]})};
  expect(rooms({...input,plans:[plan],executions:[{requirement:'r',revision:1,tasks:['missing']} ]})[0])
    .toMatchObject({blocked:1,estimateReason:'实施链包含缺失或已作废任务'});
  expect(rooms({...input,plans:[plan],requirements:[{...input.requirements[0],state:'paused'}]})[0]?.estimateReason).toBe('需求已暂停');
});

test('未全部完成时项目和员工进度不能四舍五入到100%', () => {
  const tasks=Array.from({length:200},(_,i)=>({id:String(i),project_ref:'app',state:i===199?'doing':'done'}));
  expect(rooms({tasks})[0]?.progress.percent).toBe(99);
  const activity={checklist:{done:199,total:200,at:0}} as RuntimeAgentView['activity'];
  expect(employeeProgress({activity}).percent).toBe(99);
  expect(employeeProgress({activity:{...activity,checklist:{done:200,total:200,at:0}} as RuntimeAgentView['activity']}).percent).toBe(100);
  expect(employeeProgress({}).percent).toBeUndefined();
});

test('项目ETA必须包含执行后的独立复核，缺少复核样本则保持未知', () => {
  const tasks=[{id:'work',project_ref:'app',state:'doing',reviewer_role:'qa',kind:'task'}];
  const agents=[agent({taskId:'work',project:{id:'app',name:'产品'},phase:'execute',estimate:{status:'estimated',samples:5,lowerSeconds:30,upperSeconds:60}})];
  expect(rooms({tasks,agents})[0]?.estimateReason).toBe('后续独立复核耗时尚无法估计');
  const history:PhaseDuration[]=Array.from({length:5},(_,i)=>({task:`old-${i}`,project:'app',role:'qa',kind:'task',phase:'review',seconds:120,at:i}));
  expect(rooms({tasks,agents,history})[0]?.estimate).toMatchObject({status:'estimated',lowerSeconds:150,upperSeconds:180});
  expect(rooms({tasks,agents:[{...agents[0]!,state:'unknown'}],history})[0]?.estimate.status).toBe('unavailable');
});

test('并行任务ETA以最慢下界与保守总上界汇总，阻塞任务撤回时间承诺', () => {
  const tasks=[{id:'a',project_ref:'app',state:'review'},{id:'b',project_ref:'app',state:'review'}];
  const agents=tasks.map((t,i)=>agent({id:t.id,taskId:t.id,phase:'review',estimate:{status:'estimated',samples:5,lowerSeconds:20+i*10,upperSeconds:50+i*10}}));
  expect(rooms({tasks,agents})[0]?.estimate).toMatchObject({lowerSeconds:30,upperSeconds:110});
  expect(rooms({tasks:[tasks[0]!,{...tasks[1]!,state:'blocked'}],agents})[0]?.estimate.status).toBe('unavailable');
});
