import {expect,test} from 'bun:test';
import type {RuntimeAgentView,RuntimeDashboard,RuntimeTransfer} from '../../src/runtime-dashboard.ts';
import {onDuty,roomAgents,roomHandoffs,staffStatus,portraitIndex,finishText} from '../src/ui/meeting-rooms.ts';
import {employeeProgress} from '../../src/runtime-projects.ts';
const a=(state:RuntimeAgentView['state'],extra:Partial<RuntimeAgentView>={}):RuntimeAgentView=>({id:'e',name:'工程',role:'engineering',hostId:'local',state,modelSource:'unknown',action:'',...extra});
const transfer=(extra:Partial<RuntimeTransfer>={}):RuntimeTransfer=>({id:'delivery',taskId:'t',title:'实现功能',from:'developer',to:'reviewer',at:10,kind:'review',label:'交付复核',...extra});
const project={id:'p',name:'项目'};
const handoffData=(agents:RuntimeAgentView[],transfers:RuntimeTransfer[]):RuntimeDashboard=>({agents,transfers} as RuntimeDashboard);

test('离场交接人保留头像身份，来源项目已清空也能连接当前复核者，人数不增加',()=>{
  const source=a('idle',{id:'developer',name:'开发员工'});
  const receiver=a('running',{id:'reviewer',taskId:'t',project});
  const data=handoffData([source,receiver],[transfer()]);
  const result=roomHandoffs(data,'p',new Set());
  expect(result.transfers.map(t=>t.id)).toEqual(['delivery']);
  expect(result.references).toEqual([{id:'developer',agent:source,name:'开发员工',status:'已离场'}]);
  expect(roomAgents(data,'p').map(a=>a.id)).toEqual(['reviewer']);
  expect(roomHandoffs(data,'company-unassigned',new Set(['delivery']))).toEqual({transfers:[],references:[]});
});

test('只保留当前工作相关或正在播放的新交接，不将无在岗端点的历史记录放回场景',()=>{
  const data=handoffData([
    a('idle',{id:'developer'}),
    a('running',{id:'reviewer',taskId:'next-task',project}),
  ],[transfer()]);
  expect(roomHandoffs(data,'p',new Set()).transfers).toHaveLength(0);
  expect(roomHandoffs(data,'p',new Set(['delivery'])).transfers).toHaveLength(1);
  const vacant=handoffData(data.agents.map(agent=>({...agent,state:'idle'})),data.transfers);
  expect(roomHandoffs(vacant,'p',new Set(['delivery']))).toEqual({transfers:[],references:[]});
  // A matching task on a departed endpoint cannot attach to a present employee's unrelated task.
  data.agents[0]!.taskId='t';
  expect(roomHandoffs(data,'p',new Set()).transfers).toHaveLength(0);
});

test('返工只显示该任务最新方向；时间相同按 ID 稳定选择，与输入顺序无关',()=>{
  const reviewer=a('idle',{id:'reviewer'});
  const developer=a('running',{id:'developer',taskId:'t',project});
  const review=transfer({id:'review',at:1});
  const rework=transfer({id:'rework-a',at:2,from:'reviewer',to:'developer',kind:'rework'});
  const newer=transfer({...rework,id:'rework-b'});
  const data=handoffData([reviewer,developer],[newer,review,rework]);
  const result=roomHandoffs(data,'p',new Set(['review']));
  expect(result.transfers.map(t=>t.id)).toEqual(['rework-b']);
  expect(result.references.map(r=>r.id)).toEqual(['reviewer']);
  expect(roomHandoffs({...data,transfers:[...data.transfers].reverse()},'p',new Set())).toEqual(result);
  // The latest delivery moved to other employees; an old matching endpoint is not enough.
  data.transfers.push(transfer({id:'elsewhere',at:3,from:'other-one',to:'other-two'}));
  expect(roomHandoffs(data,'p',new Set(['review']))).toEqual({transfers:[],references:[]});
});

test('跨项目员工、失联员工和已删除档案使用明确身份状态，同一参考人去重',()=>{
  const source=a('running',{id:'developer',name:'开发员工',project:{id:'other',name:'另一个项目'},taskId:'other'});
  const unknown=a('unknown',{id:'unknown',taskId:'old'});
  const receiver=a('running',{id:'reviewer',taskId:'t',project});
  const second=a('running',{id:'second',taskId:'second-task',project});
  const third=a('running',{id:'third',taskId:'third-task',project});
  const fourth=a('running',{id:'fourth',taskId:'fourth-task',project});
  const data=handoffData([source,unknown,receiver,second,third,fourth],[
    transfer(),
    transfer({id:'second',taskId:'second-task',to:'second'}),
    transfer({id:'third',taskId:'third-task',from:'unknown',to:'third'}),
    transfer({id:'fourth',taskId:'fourth-task',from:'removed-employee-id',to:'fourth'}),
  ]);
  const result=roomHandoffs(data,'p',new Set());
  expect(result.transfers).toHaveLength(4);
  expect(result.references).toHaveLength(3);
  expect(result.references.find(r=>r.id==='developer')?.status).toBe('其他项目');
  expect(result.references.find(r=>r.id==='unknown')?.status).toBe('状态待确认');
  expect(result.references.find(r=>r.id==='removed-employee-id')).toEqual({id:'removed-employee-id',name:'员工 removed-',status:'身份待补'});
  expect(roomAgents(data,'p')).toHaveLength(4);
});

test('已在本项目场上的两端直接连线，缺少身份和自交接不生成悬空头像',()=>{
  const data=handoffData([
    a('running',{id:'developer',project,taskId:'t'}),
    a('running',{id:'reviewer',project,taskId:'t'}),
  ],[
    transfer(),
    transfer({id:'self',at:20,from:'reviewer',to:'reviewer'}),
    transfer({id:'missing-from',at:30,from:''}),
    transfer({id:'missing-to',at:40,to:' '}),
    transfer({id:'',at:50}),
    transfer({id:'missing-task',taskId:'',at:60}),
    transfer({id:'invalid-time',at:NaN}),
  ]);
  expect(roomHandoffs(data,'p',new Set())).toEqual({transfers:[data.transfers[0]!],references:[]});
});

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
