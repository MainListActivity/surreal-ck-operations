import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {ModelFacts} from './ranking.ts';
import type {LargeRequest} from './trends.ts';

export const URGENT_WINDOW_MS=24*3600_000;
export const QUOTA_FRESH_MS=15*60_000;
export const URGENT_REQUEST_LIMIT=5;
export interface UrgencyObservation {
 active:boolean; kind:'gift'|'subscription'|'reset'; expiresAt:string; amount:number; unit:string;
 requests:number; reason:string;
}
interface Batch {since:number;readAt:number;amount:number;seen:string[];blocked:boolean;expires:number}
export type UrgencyState=Record<string,Batch>;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');

/** Per real quota pool and deadline, shared across models and groups. No prompts or account names retained. */
export function assessUrgency(facts:ModelFacts[],requests:LargeRequest[],previous:UrgencyState,now:number){
 const state:UrgencyState=structuredClone(Object.fromEntries(Object.entries(previous).filter(([,b])=>finite(b.expires)&&b.expires>now)));
 const pools=new Map<string,{members:Set<string>;kind:UrgencyObservation['kind'];expires:number;amount:number;unit:string;readAt:number;provider?:string;accountKey?:string;wholeAccount:boolean;singleAccount?:boolean}>();
 for(const f of facts)for(const a of f.accounts){
  const readAt=Date.parse(a.readAt??'');
  if(!finite(readAt)||readAt>now||now-readAt>QUOTA_FRESH_MS||a.remainingPct===0)continue;
  const add=(kind:UrgencyObservation['kind'],deadline:string|undefined,amount:number|undefined,unit:string,scope="",wholeAccount=false)=>{
   const expires=Date.parse(deadline??'');if(!finite(expires)||expires<=now||expires-now>URGENT_WINDOW_MS||!finite(amount)||amount<=0)return;
   const key=digest(`${a.poolKey??a.account}|${kind}|${expires}|${unit}|${scope}`);
   const old=pools.get(key);if(old){old.members.add(f.id);return;}
   pools.set(key,{members:new Set([f.id]),kind,expires,amount,unit,readAt,provider:a.provider,accountKey:a.poolKey,singleAccount:a.singleAccount,wholeAccount});
  };
  for(const w of a.windows??[]){
   const poolAmbiguous=!w.model&&new Set((a.windows??[]).flatMap(x=>x.pool?[x.pool]:[])).size>1;
   if(poolAmbiguous)continue; // No model-to-pool contract: do not guess a pool's debit.
   const scope=w.pool?'pool:'+w.pool:w.model?'model:'+w.model:'';
   add('gift',w.runsOutAt,w.runsOut,w.unit??'额度',scope,!scope);
   // A model-specific, one-off trial is a grant that disappears at its deadline.
   if(w.model&&/trial|试用/i.test(w.name??w.model))add('gift',w.resetsAt,w.remainingPct,'%',scope);
   // Rolling 5-hour rate caps are not a grant that expires. Only known non-carryover cycles qualify.
   if(w.nonCarryOver===true)
    add('reset',w.resetsAt,w.remainingPct,'%',scope,!scope);
  }
  if(a.renew==='off')add('subscription',a.until,a.remainingPct,'%', '',true);
 }
 const observations=new Map<string,UrgencyObservation[]>();
 for(const [key,p] of pools){
  let b=state[key];
  if(!b||p.readAt>b.readAt&&p.amount!==b.amount)b=state[key]={since:now,readAt:p.readAt,amount:p.amount,seen:[],blocked:false,expires:p.expires};
  if(p.readAt>=b.readAt){
   const members=new Set([...p.members].map(id=>id.replace(/:(?:max|high|medium|low|none|xhigh)$/,'')));
   for(const r of requests){
    const accountMatches=p.singleAccount===true||!!r.accountKey&&r.accountKey===p.accountKey;
    const memberMatches=members.has(r.model)||(p.wholeAccount&&!!p.provider&&r.model.slice(0,r.model.lastIndexOf('/'))===p.provider&&accountMatches);
    if(r.at<=b.since||r.at>=p.readAt||!memberMatches||p.singleAccount===false&&!accountMatches||b.seen.includes(r.id))continue;
    if(b.seen.length<URGENT_REQUEST_LIMIT)b.seen.push(r.id);
   }
   if(b.seen.length>=URGENT_REQUEST_LIMIT&&p.amount===b.amount)b.blocked=true;
   b.readAt=p.readAt;
  }
  const label=p.kind==='gift'?'赠送额度即将过期':p.kind==='subscription'?'订阅即将到期':'不结转额度即将重置';
  const observation:UrgencyObservation={active:!b.blocked&&p.readAt>=b.readAt&&p.amount===b.amount,kind:p.kind,expiresAt:new Date(p.expires).toISOString(),amount:p.amount,unit:p.unit,requests:b.seen.length,
   reason:p.readAt<b.readAt||p.amount!==b.amount?'额度读数早于已记录状态，等待新观测':b.blocked?'5条输入超过50,000 token的成功请求后，临期额度未变化，已取消紧急优先':`${label}；${p.amount}${p.unit}；有效大请求 ${b.seen.length}/5`};
  for(const id of p.members)(observations.get(id)??observations.set(id,[]).get(id)!).push(observation);
 }
 return {state,facts:facts.map(f=>({...f,urgency:(observations.get(f.id)??[]).sort((a,b)=>Number(b.active)-Number(a.active)||Date.parse(a.expiresAt)-Date.parse(b.expiresAt))[0]}))};
}

/** Serialized, atomic local observation state. Restarting or previewing never re-admits an unchanged batch. */
export class UrgencyTracker {
 private pending?:Promise<ModelFacts[]>;
 constructor(private file:string){}
 update(facts:ModelFacts[],requests:LargeRequest[],now:number):Promise<ModelFacts[]>{
  const prior=this.pending;
  const job=(async()=>{await prior?.catch(()=>undefined);let previous:UrgencyState={};
   try{previous=JSON.parse(await readFile(this.file,'utf8'));if(!previous||Array.isArray(previous)||typeof previous!=='object')throw Error('invalid urgency state');}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   const result=assessUrgency(facts,requests,previous,now);
   await mkdir(dirname(this.file),{recursive:true,mode:0o700});await writeFile(this.file+'.tmp',JSON.stringify(result.state),{mode:0o600});await rename(this.file+'.tmp',this.file);
   return result.facts;
  })();
  const tracked=job.finally(()=>{if(this.pending===tracked)this.pending=undefined;});this.pending=tracked;return tracked;
 }
}
