import {test,expect} from 'bun:test';
import {ruleOrder} from '../src/model-routing/rules.ts';
import {DEFAULT_POLICY} from '../src/model-routing/weights.ts';
import type {ModelFacts} from '../src/model-routing/ranking.ts';
const now=Date.now();
const fact=(id:string,aa=50,ttft=30000):ModelFacts=>({id,aa:{score:aa,rank:1},price:{free:false,input:1,output:2},accounts:[{account:id,kind:'plan',remainingPct:80}],usage:{source:'magpie',period:'7d',collectedAt:new Date(now).toISOString(),scope:'provider-model',requests:20,errors:0,ttftSamples:20,speedSamples:20,ttftMs:ttft,tokensPerSecond:60}});
test('100 AA at 300 seconds loses to 50 AA at 30 seconds; automatic order is exactly total score order',()=>{
 const rows=ruleOrder([fact('slow',100,300000),fact('usable',50,30000),fact('fast',40,1000)],[],now);
 expect(rows.findIndex(r=>r.facts.id==='usable')).toBeLessThan(rows.findIndex(r=>r.facts.id==='slow'));
 expect(rows.map(r=>r.decision.score)).toEqual(rows.map(r=>r.decision.score!).sort((a,b)=>b-a));
 expect(rows.every(r=>r.decision.band===undefined)).toBe(true);
});
test('a measured 300-second model cannot use first-five-attempt exploration to outrank a usable 30-second model',()=>{
 const slow=fact('slow',100,300000),usable=fact('usable',50,30000);slow.usage!.requests=1;
 expect(ruleOrder([slow,usable],[],now)[0]!.facts.id).toBe('usable');
});
test('free models ignore exhausted supplier quota, including manual free overrides',()=>{
 const f=fact('free');f.price.free=true;
 const full=ruleOrder([f],[],now)[0]!.decision;
 f.accounts[0]!.remainingPct=0;
 expect(ruleOrder([f],[],now)[0]!.decision.score).toBe(full.score);
 f.price.free=false;
 expect(ruleOrder([f],[],now)[0]!.decision.score).toBe(0);
 const p=structuredClone(DEFAULT_POLICY);p.billingOverrides.free='free';
 expect(ruleOrder([f],[],now,p)[0]!.decision.score).toBe(full.score);
});
test('longer TTFT monotonically reduces score and no 20 second cliff or hidden class layer remains',()=>{
 const scores=[1000,19000,20000,21000,30000,300000].map(t=>ruleOrder([fact('a',50,t)],[],now)[0]!.decision.score!);
 expect(scores).toEqual([...scores].sort((a,b)=>b-a));expect(scores[2]!-scores[3]!).toBeLessThan(3);
});
test('fresh models explore; failures remove exploration and persistent failures score zero',()=>{
 const f=fact('new');f.usage=undefined;
 const fresh=ruleOrder([f],[],now)[0]!.decision;expect(fresh.factors!.exploration).toBeGreaterThan(0);
 f.health={source:'magpie-routing',attempts:5,errors:5,consecutiveErrors:5,excluded:true};
 const bad=ruleOrder([f],[],now)[0]!.decision;expect(bad.score).toBe(0);expect(bad.factors!.exploration).toBe(0);
});
test('price shows 0–100 utility, not a misleading five-point total; factors reproduce final score',()=>{
 const f=fact('paid');f.accounts[0]!.kind='api';
 const d=ruleOrder([f],[],now)[0]!.decision,x=d.factors!;
 expect(d.contributions!.price!.value).toBeLessThan(1);expect(x.estimatedCost).toBe(1.5);
 expect(d.score).toBeCloseTo(Math.min(100,x.base*x.latency*x.availability*x.reliability*x.urgency+x.exploration));
});
