import {expect,test} from 'bun:test';
import type {RuntimeAgentView,RuntimeDashboard} from '../../src/runtime-dashboard.ts';
import {onDuty,roomAgents,staffStatus,portraitIndex,finishText} from '../src/ui/meeting-rooms.ts';
import {employeeProgress} from '../../src/runtime-projects.ts';
const a=(state:RuntimeAgentView['state'],extra:Partial<RuntimeAgentView>={}):RuntimeAgentView=>({id:'e',name:'工程',role:'engineering',hostId:'local',state,modelSource:'unknown',action:'',...extra});

test('总览保留执行、阻塞与有任务的失联员工，空闲旧会话不占座位',()=>{
  expect(onDuty(a('running'))).toBe(true);
  expect(onDuty(a('idle',{taskState:'blocked'}))).toBe(true);
  expect(onDuty(a('unknown',{taskId:'t'}))).toBe(true);
  expect(onDuty(a('idle'))).toBe(false);expect(onDuty(a('waiting'))).toBe(false);expect(onDuty(a('waiting',{taskId:'t'}))).toBe(true);expect(onDuty(a('unknown'))).toBe(false);
  const agents=[...Array.from({length:8},(_,i)=>a('running',{id:`e${i}`,project:{id:'p',name:'项目'}})),a('idle',{project:{id:'p',name:'项目'}})];
  const room=roomAgents({agents} as RuntimeDashboard,'p');
  expect(room).toHaveLength(8);expect(roomAgents({agents} as RuntimeDashboard,'other')).toHaveLength(0);
  expect(roomAgents({agents:[a('running')]} as RuntimeDashboard,'company-unassigned')).toHaveLength(1);
});

test('同一编制跨项目复用形象，分身以员工实例 ID 区分',()=>{
  const one=a('running',{id:'one',provider:'claude',definitionId:'engineering-claude'});
  const two={...one,id:'two',project:{id:'another',name:'另一个项目'}};
  expect(portraitIndex(one)).toBe(portraitIndex(two));
  expect(portraitIndex(one)).not.toBe(portraitIndex({...one,provider:'factory-droid'}));
});

test('失联与结束回合不显示工作闪烁；员工清单不使用项目任务完成率',()=>{
  expect(staffStatus(a('unknown',{taskId:'t'})).kind).toBe('unknown');
  expect(staffStatus(a('idle',{taskState:'blocked'})).kind).toBe('blocked');
  expect(staffStatus(a('running',{activity:{state:'completed'} as any})).kind).toBe('waiting');
  expect(employeeProgress({activity:{checklist:{done:2,total:5,at:1}} as any}).percent).toBe(40);
  expect(employeeProgress(a('running',{progress:{done:5,total:5} as any})).percent).toBeUndefined();
  expect(employeeProgress({activity:{checklist:{done:6,total:5,at:1}} as any}).percent).toBeUndefined();
});

test('ETA 给出预计结束区间，样本不足不生成时间',()=>{
  const at=Date.now();
  expect(finishText({status:'estimated',samples:5,lowerSeconds:300,upperSeconds:900},at)).toContain('结束');
  expect(finishText({status:'insufficient',samples:2},at)).toBeUndefined();
  expect(finishText({status:'estimated',samples:5,lowerSeconds:NaN,upperSeconds:900},at)).toBeUndefined();
});

test('总览 4 人保留形象、5/8 人用头像，项目详情展开每个员工形象',async()=>{
  const {useAvatars,messagePreview}=await import('../src/ui/meeting-rooms.ts');
  expect(useAvatars(4,false)).toBe(false);expect(useAvatars(5,false)).toBe(true);expect(useAvatars(8,false)).toBe(true);
  expect(useAvatars(8,true)).toBe(false);
  expect(messagePreview({preview:'请读 task.md',context:{files:[{name:'task.md',text:'# 功能\n\n实现统一反馈入口并验证表单',truncated:false}],source:'preview',at:1}} as any)).toContain('实现统一反馈入口');
});
