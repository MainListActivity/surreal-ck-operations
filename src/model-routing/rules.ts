import type { ModelFacts } from './ranking.ts';
export const RULE_ENGINE='quality-pace-v1';
export const TTFT_LIMIT_MS=20_000;
export const AA_BAND_WIDTH=2;
export const RULE_DESCRIPTION='持续报错、额度耗尽和首 token 超过20秒的置后；优先订阅覆盖；AA每2分为同一能力档，同档首 token 更快优先，再比较生成速度、绩效和额度消耗节奏。';
export interface RuleDecision {
 band?:number; ttftMs?:number; latencySource:'recent-ewma'|'recent-last'|'historical-average'|'unknown';
 billing:'subscription'|'metered'|'unknown'; quota:'available'|'low'|'exhausted'|'unknown';
 remainingPct?:number; pace?:number; tail?:string; reason:string;
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
/** Partition first, then sort: pairwise "within two points" is not transitive. */
export function ruleOrder(facts:ModelFacts[],pins:string[]=[],now=Date.now()):Array<{facts:ModelFacts;decision:RuleDecision}> {
 const rows=facts.map((facts,i)=>{
  const latency=recentMetric(facts,'ttftMs',now),account=accountFacts(facts,now);
  const tail=facts.health?.excluded?'持续报错':account.quota==='exhausted'?'供应商已知账号额度耗尽':latency.value!==undefined&&latency.value>TTFT_LIMIT_MS?'首 token 超过20秒':undefined;
  const decision:RuleDecision={...account,ttftMs:latency.value,latencySource:latency.source,tail,reason:''};
  return {facts,i,decision,gate:facts.health?.excluded?3:account.quota==='exhausted'?2:tail?1:0,
   pin:pins.includes(facts.id)?pins.indexOf(facts.id):Infinity,
   billing:account.billing==='subscription'?0:account.billing==='unknown'?1:2,
   speed:recentMetric(facts,'tokensPerSecond',now).value};
 });
 // Anchored bands per eligibility/billing class. An excluded outlier cannot move healthy bands.
 const partitions=new Map<string,typeof rows>();
 for(const row of rows){const k=`${row.gate}:${row.billing}`;(partitions.get(k)??partitions.set(k,[]).get(k)!).push(row);}
 for(const group of partitions.values()){
  const measured=group.filter(r=>finite(r.facts.aa?.score)).sort((a,b)=>b.facts.aa!.score-a.facts.aa!.score);
  let top=Infinity,band=-1;
  for(const r of measured){if(top-r.facts.aa!.score>AA_BAND_WIDTH){top=r.facts.aa!.score;band++;}r.decision.band=band;}
 }
 const value=(n:number|undefined)=>finite(n)?n:-Infinity;
 rows.sort((a,b)=>a.gate-b.gate||a.pin-b.pin||a.billing-b.billing||
  (a.decision.band??Infinity)-(b.decision.band??Infinity)||
  (a.decision.ttftMs??Infinity)-(b.decision.ttftMs??Infinity)||
  value(b.speed)-value(a.speed)||value(b.facts.performance?.score)-value(a.facts.performance?.score)||
  value(b.facts.aa?.score)-value(a.facts.aa?.score)||value(b.decision.pace)-value(a.decision.pace)||a.i-b.i);
 return rows.map(({facts,decision,pin})=>({facts,decision:{...decision,reason:decision.tail??[
  pin!==Infinity?'人工置顶':undefined,decision.billing==='subscription'?'订阅覆盖':decision.billing==='metered'?'按量计费后备':'计费类型未知',
  decision.band===undefined?'AA未知':`能力档${decision.band+1}（AA ${facts.aa!.score}）`,
  decision.ttftMs===undefined?'首 token 未测得':`首 token ${(decision.ttftMs/1000).toFixed(2)}秒（${decision.latencySource}）`,
 ].filter(Boolean).join('；')}}));
}
