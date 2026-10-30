import {expect,test} from 'bun:test';
import {assessGoal,type GoalFact,type GoalTaskFact} from '../src/goal-governance.ts';
const goal:GoalFact={id:'g',title:'阶段一',brief:'已交付范围',state:'needs_repair',tasks:{acceptance:'final'},anchors:['final']};
const done=(id:string,extra:Partial<GoalTaskFact>={}):GoalTaskFact=>({id,title:id,state:'done',kind:'task',executorRole:'engineering',reviewerRole:'qa',dependencies:[],...extra});
const final=done('final',{kind:'gate',reviewerRole:'owner',acceptedBy:'owner'});
const outcome={expected:'阶段一已交付范围',requiredEvidence:['implementation','owner_final'] as const,responsibleRole:'gm',version:1,source:'owner'};
const assess=(tasks:GoalTaskFact[],extra:Record<string,unknown>={})=>assessGoal({goal,tasks,outcome:{...outcome,requiredEvidence:[...outcome.requiredEvidence]},now:Date.now(),...extra});
test('completed historical edges to the next phase stay disclosed without reopening accepted work',()=>{
 const historical=done('old',{dependencies:['next','external']});
 const result=assess([historical,final],{externalDependencies:[{taskId:'old',dependency:'next',goalId:'g2',state:'blocked'},{taskId:'old',dependency:'external',goalId:null,state:'done'}]});
 expect(result.graph.crossGoal).toHaveLength(1);expect(result.graph.unscoped).toHaveLength(1);
 expect(result.repairReasons).toEqual([]);expect(result.readyToComplete).toBe(true);
});
test('live work and the actual final gate still enforce unresolved external dependencies',()=>{
 for(const consumer of [done('live',{state:'blocked',dependencies:['next']}),{...final,dependencies:['next']}]){
  const tasks=consumer.id==='final'?[done('work'),consumer]:[consumer,final];
  const result=assess(tasks,{externalDependencies:[{taskId:consumer.id,dependency:'next',goalId:'g2',state:'blocked'}]});
  expect(result.repairReasons.some(r=>r.code==='dependency_cross_goal')).toBe(true);expect(result.readyToComplete).toBe(false);
 }
});
test('a completed goal-less dependency satisfies a live edge but a void dependency remains a gap',()=>{
 for(const state of ['done','void']){
  const result=assess([done('work'),{...final,dependencies:['external']}],{externalDependencies:[{taskId:'final',dependency:'external',goalId:null,state}]});
  expect(result.readyToComplete).toBe(state==='done');
 }
});
