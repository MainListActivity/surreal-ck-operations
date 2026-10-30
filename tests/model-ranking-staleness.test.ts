import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ruleOrder} from '../src/model-routing/rules.ts';
import {DEFAULT_POLICY,rankingPolicy} from '../src/model-routing/weights.ts';
import type {ModelFacts} from '../src/model-routing/ranking.ts';
import {readUsageSamples} from '../src/model-routing/trends.ts';
import {rankingPolicySchema} from '../plugin/shared/rpc.ts';
import {routingCalculation,routingMetrics} from '../plugin/shared/model-routing-view.ts';
const now=Date.parse('2026-10-30T12:00:00Z'),hour=3600000;
const fact=(id:string,ageHours=0):ModelFacts=>({id,lastRequestAt:new Date(now-ageHours*hour).toISOString(),aa:{score:50,rank:1},price:{free:false},accounts:[{account:id,kind:'subscription',remainingPct:100}],usage:{source:'magpie',scope:'provider-model',period:'7d',collectedAt:new Date(now).toISOString(),requests:10,errors:0,ttftSamples:10,speedSamples:10,ttftMs:60000,tokensPerSecond:50}});
test('stale channel-model gains bounded, increasing score; new attempt resets it and refresh time does not',()=>{
 const scores=[0,1,25,100,1000].map(age=>ruleOrder([fact('p/model',age)],[],now)[0]!.decision);
 expect(scores[0]!.factors!.staleness).toBe(0);expect(scores[1]!.factors!.staleness).toBe(0);
 expect(scores.map(d=>d.score)).toEqual(scores.map(d=>d.score!).sort((a,b)=>a-b));
 expect(scores[2]!.factors!.staleness).toBeGreaterThan(0);expect(scores.at(-1)!.factors!.staleness).toBeLessThan(20);
 const f=fact('p/model',100);f.health={source:'magpie-routing',attempts:1,errors:1,consecutiveErrors:1,excluded:false,lastAttemptAt:new Date(now).toISOString()};
 expect(ruleOrder([f],[],now)[0]!.decision.factors!.staleness).toBe(0);
});
test('staleness is a separate tunable score term; zero preserves previous scores and global ordering/pins',()=>{
 const p=structuredClone(DEFAULT_POLICY);p.weights.staleness=0;
 const fresh=fact('p/model',0),old=fact('q/model',100);
 expect(ruleOrder([fresh],[],now,p)[0]!.decision.score).toBe(ruleOrder([old],[],now,p)[0]!.decision.score);
 const enabled=ruleOrder([fresh,old],[],now);expect(enabled[0]!.facts.id).toBe('q/model');
 expect(enabled.every(r=>r.decision.band===undefined)).toBe(true);
 expect(ruleOrder([fresh,old],['p/model'],now)[0]!.facts.id).toBe('p/model');
 const d=enabled[0]!.decision,f=d.factors!;
 expect(d.score).toBeCloseTo(100*(1-(1-f.utility!/100)**f.urgency)+f.exploration+f.staleness!);
 p.weights.staleness=100;expect(ruleOrder([old],[],now,p)[0]!.decision.score).toBeGreaterThan(d.score!);
});
test('excluded and exhausted models gain no stale bonus; unknown request age never fabricates one',()=>{
 for(const bad of ['excluded','exhausted']){
  const f=fact('p/model',500);if(bad==='excluded')f.health={source:'magpie-routing',attempts:5,errors:5,consecutiveErrors:5,excluded:true};else f.accounts[0]!.remainingPct=0;
  const d=ruleOrder([f],[],now)[0]!.decision;expect(d.score).toBe(0);expect(d.factors!.staleness).toBe(0);
 }
 const f=fact('p/model');delete f.lastRequestAt;
 const d=ruleOrder([f],[],now)[0]!.decision;expect(d.sampleAgeMs).toBeUndefined();expect(d.factors!.staleness).toBe(0);
});
test('legacy weights acquire only the new default; unknown or invalid weights remain rejected',()=>{
 const old=structuredClone(DEFAULT_POLICY) as any;delete old.weights.staleness;old.weights.latency=10;
 expect(rankingPolicy(old).weights).toEqual({...old.weights,staleness:20});
 expect(rankingPolicySchema.parse(old).weights).toEqual(rankingPolicy(old).weights);
 const staleOnly={...old,weights:Object.fromEntries(Object.keys(DEFAULT_POLICY.weights).map(k=>[k,k==='staleness'?100:0]))};
 expect(()=>rankingPolicy(staleOnly)).toThrow();expect(rankingPolicySchema.safeParse(staleOnly).success).toBe(false);
 for(const value of [-1,101,NaN,undefined])expect(()=>rankingPolicy({...old,weights:{...old.weights,staleness:value}})).toThrow();
 expect(()=>rankingPolicy({...old,weights:{...old.weights,extra:10}})).toThrow();
});
test('native request timestamps survive the 7-day metric window and remain channel isolated',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stale-ranking-'));
 try{
  const rows=[{provider:'remote-magpie/a',model:'m',t:new Date(now-10*24*hour).toISOString(),status:200},{provider:'remote-magpie/b',model:'m',t:new Date(now).toISOString(),status:500},{provider:'remote-magpie/a',model:'m',t:new Date(now+hour).toISOString(),status:200}];
  const file=join(dir,'usage.jsonl');await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n'));
  const samples=await readUsageSamples(now,file);
  expect(samples.lastRequestAt!.get('remote-magpie/a/m')).toBe(rows[0]!.t);expect(samples.lastRequestAt!.get('remote-magpie/b/m')).toBe(rows[1]!.t);
  expect(samples.rows.has('remote-magpie/a/m')).toBe(false);
  const f=fact('remote-magpie/a/m',240);delete f.usage;
  expect(ruleOrder([f],[],now)[0]!.decision.factors!.exploration).toBe(0);
  expect(ruleOrder([f],[],now)[0]!.decision.factors!.staleness).toBeGreaterThan(0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('shared UI explains actual bonus and preserves legacy snapshot arithmetic',()=>{
 const decision=ruleOrder([fact('p/model',100)],[],now)[0]!.decision;
 const row={model:'p/model',accounts:[],decision} as any;
 expect(routingCalculation(row)).toContain(`+ ${decision.factors!.staleness!.toFixed(2)}`);
 expect(routingMetrics(row).find(r=>r[0]==='陈旧数据探索')?.[2]).toContain('6000 分钟');
 delete decision.factors!.staleness;expect(routingCalculation(row)).not.toContain('undefined');
});
