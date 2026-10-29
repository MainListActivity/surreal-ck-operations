import {expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {quotaAccounts,modelFacts,type ModelFacts} from '../src/model-routing/ranking.ts';
import {assessUrgency} from '../src/model-routing/urgency.ts';
import {ruleOrder} from '../src/model-routing/rules.ts';
import {ModelRoutingController} from '../src/model-routing/controller.ts';
const now=Date.parse('2026-10-29T15:00:00Z'),iso=(t:number)=>new Date(t).toISOString();
const catalog=[{id:'vendor/Flash-Trial'},{id:'vendor/ordinary'},{id:'vendor/Flash-Trial-Pro'}];
function scoped(name:string){return modelFacts(catalog.map(m=>m.id),{catalog,quota:quotaAccounts([{provider:'vendor',kind:'subscription',readAt:iso(now),windows:[{name:'Weekly',remaining:0},{name,remaining:100,resetsAt:iso(now+10*3600000)}]}],now),usage:new Map(),performance:new Map()});}
test('decorated activity labels bind only the complete model token; exhausted weekly quota does not consume an independent grant',()=>{
 const facts=scoped('GLOBAL BUILD · Flash-Trial');
 expect(facts.map(f=>f.accounts[0]!.remainingPct)).toEqual([100,0,0]);
 expect(assessUrgency(facts,[],{},now).facts.map(f=>f.urgency?.active??false)).toEqual([true,false,false]);
 expect(scoped('GLOBAL BUILD · Flash-Trial · Flash-Trial-Pro').every(f=>f.accounts[0]!.remainingPct===0)).toBe(true);
});
test('a model-scoped expiring gift works without a Trial name or vendor-specific rule',()=>{
 const facts=modelFacts(['vendor/ordinary'],{catalog,quota:quotaAccounts([{provider:'vendor',kind:'subscription',readAt:iso(now),windows:[{name:'Weekly',remaining:0},{name:'Campaign credit',model:'ordinary',remaining:100,runsOut:300,runsOutAt:iso(now+3600000)}]}],now),usage:new Map(),performance:new Map()});
 expect(facts[0]!.accounts[0]!.remainingPct).toBe(100);
 expect(assessUrgency(facts,[],{},now).facts[0]!.urgency?.active).toBe(true);
});
const measured=(id:string,aa=35,ttft=9500):ModelFacts=>({id,aa:{score:aa,rank:1},price:{free:false},accounts:[{account:id,kind:'subscription',remainingPct:100}],usage:{source:'magpie',period:'7d',scope:'provider-model',collectedAt:iso(now),requests:50,errors:0,ttftSamples:50,speedSamples:50,ttftMs:ttft,tokensPerSecond:55}});
test('expired or invalid gift deadlines never bypass an exhausted ordinary budget',()=>{
 for(const runsOutAt of [iso(now-10000),'invalid']){
  const facts=modelFacts(['vendor/ordinary'],{catalog,quota:quotaAccounts([{provider:'vendor',kind:'subscription',readAt:iso(now),windows:[{name:'Weekly',remaining:0},{name:'Campaign credit',model:'ordinary',remaining:100,runsOut:300,runsOutAt}]}],now),usage:new Map(),performance:new Map()});
  expect(facts[0]!.accounts[0]!.remainingPct).toBe(0);
  expect(ruleOrder(facts,[],now)[0]!.decision.quota).toBe('exhausted');
  expect(ruleOrder(facts,[],now)[0]!.decision.score).toBe(0);
 }
});
const urgent=(id:string,hours=10)=>({...measured(id),urgency:{active:true,kind:'gift' as const,amount:100,unit:'%',requests:0,expiresAt:iso(now+hours*3600000),reason:'expiring grant'}});
test('expiring usable credit outranks new-model exploration through its score, without score saturation or layers',()=>{
 const fresh=measured('vendor/new',70);delete fresh.usage;
 const rows=ruleOrder([fresh,measured('vendor/ordinary',80,1000),urgent('vendor/gift')],[],now);
 expect(rows[0]!.facts.id).toBe('vendor/gift');
 expect(rows[0]!.decision.score).toBeGreaterThan(95);expect(rows[0]!.decision.score).toBeLessThan(100);
 expect(rows.map(r=>r.decision.score)).toEqual(rows.map(r=>r.decision.score!).sort((a,b)=>b-a));
 expect(rows.every(r=>r.decision.band===undefined)).toBe(true);
 expect(ruleOrder([urgent('a',1),urgent('b',20)],[],now)[0]!.facts.id).toBe('a');
});
test('expiry never rescues an unusable model and closer expiry still respects latency and explicit pins',()=>{
 const bad={...urgent('bad'),health:{source:'magpie-routing' as const,attempts:5,errors:5,consecutiveErrors:5,excluded:true}};
 const slow=urgent('slow');slow.usage!.ttftMs=300000;
 const normal=measured('normal',50,30000);
 expect(ruleOrder([bad,slow,normal],[],now)[0]!.facts.id).toBe('normal');
 expect(ruleOrder([bad],[],now)[0]!.decision.score).toBe(0);
 expect(ruleOrder([urgent('gift'),normal],['normal'],now)[0]!.facts.id).toBe('normal');
});
test('stale remote quota without any known expiring window is refreshed to discover a newly opened gift',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-discovery-'));const calls:string[]=[];
 try{
  const rows=(fresh=false)=>[{provider:'remote-magpie/vendor',kind:'subscription',readAt:iso(fresh?now:now-120000),windows:[{name:'Weekly',remaining:0},...(fresh?[{name:'GLOBAL BUILD · Flash-Trial',remaining:100,resetsAt:iso(now+3600000)}]:[])]}];
  await writeFile(join(dir,'usage.jsonl'),'');
  const c=new ModelRoutingController({query:async()=>[[]]} as never,dir,'unused',{now:()=>now,usageLog:join(dir,'usage.jsonl'),routingLogDir:join(dir,'absent'),fetch:(async()=>Response.json({period:'7d',models:[]})) as unknown as typeof fetch,output:async args=>{calls.push(args.join(' '));return JSON.stringify(rows(args[1]==='refresh'));}});
  const facts=await c.rankingFacts(['remote-magpie/vendor/Flash-Trial']);
  expect(calls).toContain('quota refresh remote-magpie/vendor --json');expect(facts[0]!.urgency?.active).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
