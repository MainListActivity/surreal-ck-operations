import type { ModelFacts } from './ranking.ts';
import {DEFAULT_POLICY,rankingPolicy,BILLING_LABELS,type RankingPolicy,type BillingClass} from './weights.ts';
export const RULE_ENGINE='quality-pace-v2';
export const TTFT_LIMIT_MS=20_000;
export const AA_BAND_WIDTH=2;
export const RULE_DESCRIPTION='模型持续报错、额度耗尽、首 token 超过20秒置后；无请求记录的新模型优先试用；按AA能力分档，再按免费、套餐/积分覆盖、未知、额外付费分层；层内使用可配置权重评分，不调用JEV。';
export interface RuleDecision {
 band?:number; ttftMs?:number; latencySource:'recent-ewma'|'recent-last'|'historical-average'|'unknown';
 billing:'subscription'|'metered'|'unknown'; quota:'available'|'low'|'exhausted'|'unknown';
 remainingPct?:number; pace?:number; tail?:string; reason:string; costClass?:BillingClass; coldStart?:boolean; score?:number; contributions?:Record<string,{value?:number;weight:number;points:number}>;
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
 const paces=known.flatMap(a=>{
  const windows=a.windows?.filter(w=>finite(w.remainingPct)&&w.remainingPct>=0&&w.remainingPct<=100&&w.resetsAt&&Date.parse(w.resetsAt)>now)??[];
  // Longest known window, as a weekly/monthly budget; short caps still constrain remainingPct.
  const w=windows.sort((a,b)=>Date.parse(b.resetsAt!)-Date.parse(a.resetsAt!))[0];
  return w?[w.remainingPct/Math.max((Date.parse(w.resetsAt!)-now)/3600_000,1/60)]:[];
 });
 return {billing,quota,remainingPct:remaining,pace:paces.length?Math.max(...paces):undefined};
}
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
/** Same engine for preview and publication. Safety, exploration and ability never become purchasable weights. */
export function ruleOrder(facts:ModelFacts[],pins:string[]=[],now=Date.now(),input:RankingPolicy=DEFAULT_POLICY):Array<{facts:ModelFacts;decision:RuleDecision}> {
 const policy=rankingPolicy(input),total=Object.values(policy.weights).reduce((a,b)=>a+b,0);
 const rows=facts.map((facts,i)=>{
  const latency=recentMetric(facts,'ttftMs',now),account=accountFacts(facts,now);
  const costClass=policy.billingOverrides[facts.id]??(facts.price.free?'free':account.billing==='subscription'?'included':account.billing==='metered'?'paid':'unknown');
  const tail=facts.health?.excluded?'该模型持续报错':account.quota==='exhausted'&&!facts.price.free?'供应商已知账号额度耗尽':latency.value!==undefined&&latency.value>TTFT_LIMIT_MS?'首 token 超过20秒':undefined;
  // A refusal without a completed native usage record is an attempt, never a new model.
  const coldStart=!tail&&!(facts.usage?.requests)&&!(facts.health?.attempts);
  const speed=recentMetric(facts,'tokensPerSecond',now).value;
  const hit=facts.usage?.cacheHitRate;
  const price=costClass==='free'||costClass==='included'?0:finite(facts.price.input)&&finite(facts.price.output)&&finite(hit)&&finite(facts.price.cacheHit)?facts.price.input*(1-clamp(hit))+facts.price.cacheHit*clamp(hit)+facts.price.output:undefined;
  const values={pace:account.pace===undefined?undefined:account.pace/(account.pace+1),latency:latency.value===undefined?undefined:clamp(1-latency.value/TTFT_LIMIT_MS),intelligence:facts.aa?clamp(facts.aa.score/100):undefined,speed:speed===undefined?undefined:speed/(speed+50),performance:facts.performance?clamp(facts.performance.score/5):undefined,price:price===undefined?undefined:1/(1+price)};
  const contributions=Object.fromEntries(Object.entries(policy.weights).map(([key,weight])=>{const value=values[key as keyof typeof values];return [key,{value,weight,points:100*weight*(value??0)/total}];}));
  const decision:RuleDecision={...account,ttftMs:latency.value,latencySource:latency.source,tail,costClass,coldStart,contributions,score:Object.values(contributions).reduce((s,c)=>s+c.points,0),reason:''};
  return {facts,i,decision,gate:facts.health?.excluded?3:tail==='供应商已知账号额度耗尽'?2:tail?1:0,pin:pins.includes(facts.id)?pins.indexOf(facts.id):Infinity};
 });
 const partitions=new Map<number,typeof rows>();
 for(const row of rows)(partitions.get(row.gate)??partitions.set(row.gate,[]).get(row.gate)!).push(row);
 for(const group of partitions.values()){
  const measured=group.filter(r=>finite(r.facts.aa?.score)).sort((a,b)=>b.facts.aa!.score-a.facts.aa!.score);
  let top=Infinity,band=-1;
  for(const r of measured){if(top-r.facts.aa!.score>policy.bandWidth){top=r.facts.aa!.score;band++;}r.decision.band=band;}
 }
 const costs:Record<BillingClass,number>={free:0,included:1,unknown:2,paid:3};
 rows.sort((a,b)=>a.gate-b.gate||Number(!!b.decision.coldStart)-Number(!!a.decision.coldStart)||
  (a.decision.band??Infinity)-(b.decision.band??Infinity)||costs[a.decision.costClass!]-costs[b.decision.costClass!]||a.pin-b.pin||
  b.decision.score!-a.decision.score!||a.i-b.i);
 return rows.map(({facts,decision,pin})=>({facts,decision:{...decision,reason:decision.tail??[
  decision.coldStart?'新模型优先试用':undefined,pin!==Infinity?'本层人工置顶':undefined,BILLING_LABELS[decision.costClass!],
  decision.band===undefined?'AA未知':`能力档${decision.band+1}（AA ${facts.aa!.score}）`,
  `综合分 ${decision.score!.toFixed(2)}`,decision.ttftMs===undefined?'首 token 未测得':`首 token ${(decision.ttftMs/1000).toFixed(2)}秒`,
 ].filter(Boolean).join('；')}}));
}
