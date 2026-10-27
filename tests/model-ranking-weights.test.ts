import {expect,test} from 'bun:test';
import {DEFAULT_POLICY,rankingPolicy} from '../src/model-routing/weights.ts';
import {ruleOrder} from '../src/model-routing/rules.ts';
import {RankingRefresher,type ModelFacts} from '../src/model-routing/ranking.ts';
const now=Date.parse('2026-10-27T12:00:00Z');
function fact(id:string,ttft=1000):ModelFacts{return {id,aa:{rank:1,score:60},accounts:[{account:'anon',kind:'plan',remainingPct:80,windows:[{remainingPct:80,resetsAt:new Date(now+7*86400000).toISOString()}]}],price:{free:false},usage:{source:'magpie',scope:'provider-model',period:'7d',collectedAt:new Date(now).toISOString(),requests:5,errors:0,speedSamples:2,ttftSamples:5,ttftMs:ttft,tokensPerSecond:50}};}
const policy=(key:keyof typeof DEFAULT_POLICY.weights)=>({...structuredClone(DEFAULT_POLICY),weights:Object.fromEntries(Object.keys(DEFAULT_POLICY.weights).map(k=>[k,k===key?100:0])) as typeof DEFAULT_POLICY.weights});
test('weights change the within-layer winner and each component sums exactly to the total',()=>{
 const fast=fact('p/fast',100),urgent=fact('p/urgent',19000);urgent.accounts[0]!.windows=[{remainingPct:60,resetsAt:new Date(now+3600000).toISOString()}];
 const latency=ruleOrder([urgent,fast],[],now,policy('latency')),pace=ruleOrder([fast,urgent],[],now,policy('pace'));
 expect(latency[0]!.facts.id).toBe('p/fast');expect(pace[0]!.facts.id).toBe('p/urgent');
 for(const r of [...pace,...latency])expect(r.decision.score).toBeCloseTo(Object.values(r.decision.contributions!).reduce((s,v)=>s+v.points,0),10);
});
test('ability and cost layers cannot be bought with weights or pins; manual classification is explicit',()=>{
 const free=fact('p/free',19000),included=fact('p/included',100),paid=fact('p/paid',1),strong=fact('p/strong',19000);
 free.price.free=true;paid.accounts[0]!.kind='api';strong.aa!.score=65;strong.accounts[0]!.kind='api';
 const rows=ruleOrder([paid,included,free,strong],['p/paid'],now,policy('latency'));
 expect(rows.map(r=>r.facts.id)).toEqual(['p/strong','p/free','p/included','p/paid']);
 const p=policy('latency');p.billingOverrides['p/included']='paid';
 expect(ruleOrder([paid,included],[],now,p)[0]!.facts.id).toBe('p/paid');
});
test('truly untried models get exploration priority; any error attempt prevents infinite new-model promotion',()=>{
 const known=fact('p/known'),fresh=fact('p/new');delete fresh.usage;fresh.aa!.score=30;
 expect(ruleOrder([known,fresh],[],now)[0]!.decision.coldStart).toBe(true);
 fresh.health={source:'magpie-routing',attempts:1,errors:1,consecutiveErrors:1,excluded:false};
 expect(ruleOrder([fresh,known],[],now)[0]!.facts.id).toBe('p/known');
 fresh.health.excluded=true;expect(ruleOrder([fresh,known],['p/new'],now)[1]!.decision.tail).toContain('模型持续报错');
});
test('failing one model never demotes a healthy sibling on the same provider',()=>{
 const bad=fact('p/bad'),good=fact('p/good');bad.health={source:'magpie-routing',attempts:3,errors:3,consecutiveErrors:3,excluded:true};
 expect(ruleOrder([bad,good],['p/bad'],now).map(r=>r.facts.id)).toEqual(['p/good','p/bad']);
});
test('unknown metrics get no fabricated values; invalid policies fail closed',()=>{
 const missing=fact('p/missing');delete missing.usage;missing.health={source:'magpie-routing',attempts:1,errors:0,consecutiveErrors:0,excluded:false};
 const d=ruleOrder([missing],[],now,policy('latency'))[0]!.decision;
 expect(d.contributions!.latency!.value).toBeUndefined();expect(d.score).toBe(0);
 for(const p of [{...DEFAULT_POLICY,weights:{}},{...DEFAULT_POLICY,bandWidth:NaN},{...DEFAULT_POLICY,weights:{...DEFAULT_POLICY.weights,pace:-1}},policy('latency')]){
  if(p===undefined)continue;
  if(p.weights.latency===100)expect(rankingPolicy(p)).toEqual(p);else expect(()=>rankingPolicy(p)).toThrow();
 }
 expect(()=>rankingPolicy({...policy('latency'),weights:Object.fromEntries(Object.keys(DEFAULT_POLICY.weights).map(k=>[k,0]))})).toThrow();
});
test('preview uses frozen observations, matches the live engine and never applies or saves anything',async()=>{
 const a=fact('p/a',100),b=fact('p/b',19000);b.accounts[0]!.windows=[{remainingPct:90,resetsAt:new Date(now+3600000).toISOString()}];
 let applied=0,reads=0;const groups={'sck-haiku':['p/a','p/b'],'sck-opus':['manual/model']};
 const db={query:async(sql:string)=>{if(!sql.startsWith('SELECT'))throw Error('preview wrote');if(sql.includes('SELECT pins'))return [{}];return [{at:new Date(now).toISOString(),results:{'sck-haiku':{rows:[{facts:a},{facts:b}]}}}];}};
 const r=new RankingRefresher({db:db as any,groups:()=>groups,facts:async()=>{reads++;return [a,b];},apply:async()=>{applied++;}});
 const p=policy('latency'),preview=await r.preview(p);
 expect(preview.tables[0]!.rows.map(row=>row.model)).toEqual(ruleOrder([a,b],[],now,p).map(row=>row.facts.id));
 expect(preview.tables[0]!.rows[0]!.previousRank).toBe(1);
 expect((await r.preview(policy('pace'))).tables[0]!.rows[0]!.model).toBe('p/b');expect(reads).toBe(0);expect(applied).toBe(0);
 await r.preview(p,true);expect(reads).toBe(1);expect(applied).toBe(0);
});
test('exploration requests recheck after 30 seconds, then restore the configured interval once measured',async()=>{
 let calls=0,sampled=false;const fresh=fact('p/new');delete fresh.usage;
 const db={query:async(sql:string)=>sql.includes('SELECT ranking_rules')?[{ranking_refresh_minutes:10}]:[{}]};
 const r=new RankingRefresher({db:db as any,groups:()=>({'sck-haiku':['p/new']}),facts:async()=>{calls++;return [sampled?fact('p/new'):fresh];},apply:async()=>{}});
 r.trigger(0);await r.settled();r.trigger(29999);await r.settled();expect(calls).toBe(1);
 sampled=true;r.trigger(30000);await r.settled();expect(calls).toBe(2);
 r.trigger(60000);await r.settled();expect(calls).toBe(2);r.trigger(630000);await r.settled();expect(calls).toBe(3);
});
