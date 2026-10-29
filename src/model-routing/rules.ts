import type { ModelFacts } from './ranking.ts';
import {DEFAULT_POLICY,rankingPolicy,BILLING_LABELS,type RankingPolicy,type BillingClass} from './weights.ts';
export const RULE_ENGINE='quality-pace-v5';
export const TTFT_LIMIT_MS=20_000;
export const AA_BAND_WIDTH=2;
export const RULE_DESCRIPTION='手动置顶保留人工顺序；其余按非线性总分降序，不再分层。能力、速度、绩效、费用和额度消耗意愿形成几何效用，乘以首 token 延迟、可用额度与可靠性因子；临期额度加成和有限新模型探索也计入同一总分。免费模型不受供应商额度影响；持续报错或已知付费额度耗尽记0分。';
export interface RuleDecision {
 urgent?:boolean; band?:number; ttftMs?:number; latencySource:'recent-ewma'|'recent-last'|'historical-average'|'unknown';
 billing:'subscription'|'metered'|'unknown'; quota:'available'|'low'|'exhausted'|'unknown';
 remainingPct?:number; pace?:number; tail?:string; reason:string; costClass?:BillingClass; coldStart?:boolean; score?:number; factors?:{base:number;latency:number;availability:number;reliability:number;urgency:number;exploration:number;estimatedCost?:number}; contributions?:Record<string,{value?:number;weight:number;points:number;factor?:number}>;
}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
export function recentMetric(f:ModelFacts,key:string,now:number):{value?:number;source:RuleDecision['latencySource']} {
 const t=f.trends?.[key],at=t?.lastSampleAt?Date.parse(t.lastSampleAt):NaN;
 if(t&&t.samples>0&&finite(at)&&at<=now&&now-at<=15*60_000){
  if(t.sufficient&&finite(t.ewma)&&t.ewma>=0)return {value:t.ewma,source:'recent-ewma'};
  if(finite(t.current)&&t.current>=0)return {value:t.current,source:'recent-last'};
 }
 const value=key==='ttftMs'&&f.usage?.ttftSamples?f.usage.ttftMs:key==='tokensPerSecond'&&f.usage?.speedSamples?f.usage.tokensPerSecond:undefined;
 return finite(value)&&value>=0?{value,source:'historical-average'}:{source:'unknown'};
}
export function accountFacts(f:ModelFacts,now:number){
 const accounts=f.accounts;
 const known=accounts.filter(a=>finite(a.remainingPct)&&a.remainingPct!>=0&&a.remainingPct!<=100);
 // Any unmeasured account prevents a claim that every account is exhausted.
 const remaining=known.length?Math.max(...known.map(a=>a.remainingPct!)):undefined;
 const quota:RuleDecision['quota']=remaining===undefined?'unknown':remaining===0&&known.length===accounts.length?'exhausted':remaining>10?'available':remaining>0?'low':'unknown';
 const subscription=accounts.some(a=>a.kind==='subscription'||a.kind==='plan');
 const billing:RuleDecision['billing']=subscription?'subscription':accounts.some(a=>a.kind==='api')?'metered':'unknown';
 const paces=known.filter(a=>a.remainingPct!>0).flatMap(a=>{
  const windows=a.windows?.filter(w=>finite(w.remainingPct)&&w.remainingPct>=0&&w.remainingPct<=100&&w.resetsAt&&Date.parse(w.resetsAt)>now)??[];
  // Longest known window, as a weekly/monthly budget; short caps still constrain remainingPct.
  const w=windows.sort((a,b)=>Date.parse(b.resetsAt!)-Date.parse(a.resetsAt!))[0];
  return w?[w.remainingPct/Math.max((Date.parse(w.resetsAt!)-now)/3600_000,1/60)]:[];
 });
 return {billing,quota,remainingPct:remaining,pace:paces.length?Math.max(...paces):undefined};
}
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
/** One global score, with an explicit manual pin override. No ability, cost, urgency or latency partitions. */
export function ruleOrder(facts:ModelFacts[],pins:string[]=[],now=Date.now(),input:RankingPolicy=DEFAULT_POLICY):Array<{facts:ModelFacts;decision:RuleDecision}> {
 pins=[...new Set(pins)].filter(id=>facts.some(f=>f.id===id));
 const policy=rankingPolicy(input);
 const baseWeight=Object.entries(policy.weights).filter(([key])=>key!=='latency').reduce((sum,[,weight])=>sum+weight,0);
 const rows=facts.map((facts,i)=>{
  const latency=recentMetric(facts,'ttftMs',now),account=accountFacts(facts,now);
  const costClass=policy.billingOverrides[facts.id]??(facts.price.free?'free':account.billing==='subscription'?'included':account.billing==='metered'?'paid':'unknown');
  const free=costClass==='free';
  const quota=free?'available':account.quota;
  const tail=facts.health?.excluded?'该模型持续报错':quota==='exhausted'?'供应商已知账号额度耗尽':undefined;
  const requests=Math.max(facts.usage?.requests??0,facts.health?.attempts??0);
  const coldStart=requests===0&&!tail;
  const speed=recentMetric(facts,'tokensPerSecond',now).value;
  const hit=clamp(facts.usage?.cacheHitRate??0);
  const expectedCost=free||costClass==='included'?0:
   finite(facts.price.input)&&finite(facts.price.output)?facts.price.input*(1-hit)+(facts.price.cacheHit??facts.price.input)*hit+facts.price.output*0.25:undefined;
  const performance=facts.performance;
  const values={
   // A tiny positive subscription balance is useful; depletion is an availability issue, not a near-zero utility.
   pace:free?1:account.pace===undefined?0.6:0.6+0.4*account.pace/(account.pace+1),
   intelligence:facts.aa?clamp(facts.aa.score/100):0.25,
   speed:speed===undefined?0.5:speed/(speed+50),
   performance:performance?(performance.score*performance.samples+3.5*5)/(5*(performance.samples+5)):0.7,
   price:expectedCost===undefined?0.5:1/(1+expectedCost),
   latency:latency.value===undefined?0.5:1/(1+(latency.value/TTFT_LIMIT_MS)**1.3),
  };
  const contributions=Object.fromEntries(Object.entries(policy.weights).map(([key,weight])=>{
   const value=clamp(values[key as keyof typeof values]);
   const exponent=key==='latency'?weight/30:baseWeight?weight/baseWeight:0;
   const factor=exponent===0?1:Math.max(value,0.001)**exponent;
   const unknown=key==='latency'?latency.value===undefined:key==='intelligence'?!facts.aa:key==='speed'?speed===undefined:key==='performance'?!performance:key==='price'?expectedCost===undefined:false;
   return [key,{value:unknown?undefined:value,weight,factor,points:100*(1-factor)}];
  }));
  const base=100*Object.entries(contributions).filter(([key])=>key!=='latency').reduce((value,[,c])=>value*c.factor,1);
  const latencyFactor=contributions.latency!.factor;
  const availability=free?1:quota==='exhausted'?0:account.remainingPct===undefined?0.9:0.85+0.15*Math.sqrt(clamp(account.remainingPct/100));
  const observed=facts.health?.attempts?{n:facts.health.attempts,errors:facts.health.errors}:
   facts.usage?.requests?{n:facts.usage.requests,errors:facts.usage.errors}:undefined;
  const recentError=recentMetric(facts,'errorRate',now).value;
  const success=recentError===undefined?observed?clamp(1-observed.errors/(observed.n+3)):1:1-clamp(recentError);
  const reliability=success**2;
  const urgent=!tail&&facts.urgency?.active===true&&Date.parse(facts.urgency.expiresAt)>now;
  const hours=urgent?(Date.parse(facts.urgency!.expiresAt)-now)/3600000:Infinity;
  const urgency=urgent?1+0.25*(policy.weights.pace/35)/(1+hours/24):1;
  const ordinary=clamp(base*latencyFactor*availability*reliability*urgency/100)*100;
  // A bounded exploration uplift decays over five actual attempts. Errors immediately lose the uplift.
  const exploration=!tail&&!(observed?.errors)&&requests<5?0.9*(1-requests/5)*(100-ordinary)*(coldStart?1:latencyFactor*availability*reliability):0;
  const score=tail?0:Math.min(100,ordinary+exploration);
  const decision:RuleDecision={...account,quota,remainingPct:free?undefined:account.remainingPct,urgent,ttftMs:latency.value,latencySource:latency.source,
   tail,costClass,coldStart,contributions,score,factors:{base,latency:latencyFactor,availability,reliability,urgency,exploration,estimatedCost:expectedCost},reason:''};
  const pin=pins.indexOf(facts.id);
  decision.reason=[pin>=0?`手动置顶第${pin+1}位（人工覆盖）`:undefined,tail,
   free?'免费：供应商额度不扣分':BILLING_LABELS[costClass],urgent?'临期消耗加成':facts.urgency?.reason,
   exploration>0?`新模型探索 +${exploration.toFixed(2)}`:undefined,
   `非线性总分 ${score.toFixed(2)}`,latency.value===undefined?'首 token 未测得':`首 token ${(latency.value/1000).toFixed(2)}秒`].filter(Boolean).join('；');
  return {facts,decision,i,pin:pin<0?Infinity:pin};
 });
 rows.sort((a,b)=>a.pin-b.pin||b.decision.score!-a.decision.score!||a.i-b.i);
 return rows.map(({facts,decision})=>({facts,decision}));
}
