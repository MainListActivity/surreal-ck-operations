import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {nativeDecode} from './trends.ts';
import type {RequestMetrics} from './request-metrics.ts';
export interface AgentRequest extends Partial<RequestMetrics> {
 id:string;at:number;endedAt?:number;model?:string;status:number;completed?:boolean;
 source:'company-gateway'|'magpie-session';turnKey?:string;decodeTokensPerSecond?:number;decodeDurationMs?:number;
}
export interface AgentTurn {key:string;turnId:string|null;startedAt:number;endedAt?:number;partial:boolean;sessionId?:string}
export interface MetricsSummary {
 requests:number;successful:number;failed:number;inFlight:number;models:Array<{id:string;requests:number}>;
 firstResponseMs?:number;firstTextMs?:number;meanResponseMs?:number;
 outputTokens?:number;tokensPerSecond?:number;decodeTokensPerSecond?:number;timedRequests:number;tokenRequests:number;partial:boolean;
}
export function summarizeRequests(input:AgentRequest[],partial=false):MetricsSummary {
 const rows=[...input].sort((a,b)=>a.at-b.at),successful=rows.filter(r=>r.completed===true),timed=successful.filter(r=>r.ttft_ms!==undefined);
 const measured=successful.filter(r=>r.output_tokens!==undefined&&r.total_ms!==undefined&&r.total_ms>0);
 const decode=successful.filter(r=>r.decodeTokensPerSecond!==undefined&&r.output_tokens!==undefined&&r.decodeDurationMs!==undefined&&r.decodeDurationMs>0);
 const models=new Map<string,number>();for(const r of rows){const id=r.model??'unknown';models.set(id,(models.get(id)??0)+1);}
 const total=measured.reduce((s,r)=>s+r.total_ms!,0),out=measured.reduce((s,r)=>s+r.output_tokens!,0);
 return {requests:rows.length,successful:successful.length,failed:rows.filter(r=>r.completed===false).length,inFlight:rows.filter(r=>r.completed===undefined).length,
 models:[...models].slice(0,50).map(([id,requests])=>({id,requests})),firstResponseMs:rows[0]?.ttft_ms,firstTextMs:rows[0]?.first_text_ms,
 meanResponseMs:timed.length?timed.reduce((s,r)=>s+r.ttft_ms!,0)/timed.length:undefined,
 outputTokens:measured.length?out:undefined,tokensPerSecond:total?out/(total/1000):undefined,
 // Only native measurements with trustworthy decode windows participate. Never average per-request speeds.
 decodeTokensPerSecond:decode.length?decode.reduce((s,r)=>s+r.decodeTokensPerSecond!*r.decodeDurationMs!,0)/decode.reduce((s,r)=>s+r.decodeDurationMs!,0):undefined,
 timedRequests:timed.length,tokenRequests:measured.length,partial:partial||models.size>50};
}
interface State {turns:AgentTurn[];rows:AgentRequest[];gatewaySeen:boolean;trimmedBefore?:number}
/** Small durable per-agent numeric ledger; no DB or daemon RPC on the inference path. */
export class AgentTelemetry {
 private cache=new Map<string,State>();
 private listeners=new Set<(agent:string)=>void>();
 subscribe(listener:(agent:string)=>void){this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
 private changed(agent:string){for(const listener of this.listeners){try{listener(agent);}catch{}}}
 requests(agent:string){return this.get(agent).rows;}
 constructor(private dir:string){mkdirSync(dir,{recursive:true,mode:0o700});}
 private path(agent:string){return join(this.dir,createHash('sha256').update(agent).digest('hex')+'.json');}
 private get(agent:string):State{
  let s=this.cache.get(agent);if(s)return s;
  try{s=JSON.parse(readFileSync(this.path(agent),'utf8'));if(!s||!Array.isArray(s.turns)||!Array.isArray(s.rows))throw Error('invalid telemetry ledger');}catch{s={turns:[],rows:[],gatewaySeen:false};}
  this.cache.set(agent,s!);if(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);return s!;
 }
 private save(agent:string){const p=this.path(agent);writeFileSync(p+'.tmp',JSON.stringify(this.get(agent)),{mode:0o600});renameSync(p+'.tmp',p);}
 begin(agent:string,turnId:string|null,at=Date.now(),partial=false,fresh=false):AgentTurn {
  const s=this.get(agent),current=s.turns.at(-1);
  if(!fresh&&current&&current.endedAt===undefined){
   if(current.turnId===turnId)return current;
   // A gateway request may precede the first panel refresh after deployment.
   // Adopt the SDK identity without orphaning requests already bound to this partial turn.
   if(current.partial&&current.turnId===null&&turnId!==null&&at<=current.startedAt){current.turnId=turnId;current.startedAt=Math.min(current.startedAt,at);this.save(agent);return current;}
  }
  if(current&&current.endedAt===undefined)current.endedAt=Math.max(current.startedAt,at);
  const t={key:randomUUID(),turnId,startedAt:at,partial};s.turns.push(t);s.turns=s.turns.slice(-20);this.save(agent);return t;
 }
 current(agent:string){return [...this.get(agent).turns].reverse().find(t=>t.endedAt===undefined);}
 finish(agent:string,turnId:string|null,at=Date.now()){
  const s=this.get(agent),t=[...s.turns].reverse().find(t=>t.endedAt===undefined&&(t.turnId===turnId||(t.turnId===null&&t.partial)));
  if(t){t.turnId=turnId;t.endedAt=at;this.save(agent);}return t;
 }
 bindSession(agent:string,key:string,session:string){const t=this.get(agent).turns.find(t=>t.key===key);if(t&&!t.sessionId){t.sessionId=session;this.save(agent);}}
 turn(agent:string,key:string){return this.get(agent).turns.find(t=>t.key===key);}
 lastTurn(agent:string){return this.get(agent).turns.at(-1);}
 record(agent:string,row:AgentRequest){const s=this.get(agent);s.gatewaySeen=true;
  const i=s.rows.findIndex(r=>r.id===row.id);if(i<0)s.rows.push(row);else s.rows[i]=row;
  if(s.rows.length>5000){s.trimmedBefore=s.rows[s.rows.length-5000]!.at;s.rows=s.rows.slice(-5000);}
  this.save(agent);
  this.changed(agent);
 }
 progress(agent:string,id:string,metrics:Partial<RequestMetrics>){const r=this.get(agent).rows.find(r=>r.id===id);if(r){const first=r.ttft_ms===undefined&&metrics.ttft_ms!==undefined;Object.assign(r,metrics);if(first)this.changed(agent);}}
 complete(agent:string,id:string,done:boolean,metrics:Partial<RequestMetrics>={}){const r=this.get(agent).rows.find(r=>r.id===id);if(r){Object.assign(r,metrics,{completed:done,endedAt:Date.now()});this.save(agent);this.changed(agent);}}
 view(agent:string,turn=this.lastTurn(agent),turnOnly=false){
  const s=this.get(agent),rows=turn?s.rows.filter(r=>r.turnKey===turn.key):[];
  return {turn,latest:(turnOnly?rows:s.rows).at(-1),summary:summarizeRequests(rows,turn?.partial||!!(turn&&s.trimmedBefore&&s.trimmedBefore>turn.startedAt)),gatewaySeen:s.gatewaySeen};
 }
}
/** Session equality only. Cached and single-flight across panels; sanitized rows are all that survive a read. */
export class NativeUsageReader {
 private cached?:{at:number;rows:Map<string,NativeRequests>;sessions:Set<string>};
 private pending?:Promise<void>;private sessions=new Map<string,true>();
 constructor(private file:string){}
 async read(session:string,now=Date.now(),force=false):Promise<NativeRequests>{
  this.sessions.delete(session);this.sessions.set(session,true);
  if(this.sessions.size>64)this.sessions.delete(this.sessions.keys().next().value!);
  if(!force&&this.cached&&now-this.cached.at<5000&&this.cached.sessions.has(session))return this.cached.rows.get(session)??[];
  if(this.pending){await this.pending;return this.read(session,now,false);}
  const sessions=new Set(this.sessions.keys());
  this.pending=this.load(now,sessions).then(rows=>{this.cached={at:now,rows,sessions};}).finally(()=>{this.pending=undefined;});
  await this.pending;return this.cached!.rows.get(session)??[];
 }
 private async load(now:number,sessions:Set<string>){
  type Entry={item:AgentRequest;sessions:string[];handedOn:boolean;failed:boolean;rejected:boolean;route?:string};
  const rows=new Map<string,NativeRequests>(),records:Entry[]=[],routes=new Map<string,Entry>(),truncated=new Set<string>();let cursor=0;
  const stream=createReadStream(this.file,{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
  try{for await(const line of lines){let r:any;try{r=JSON.parse(line);}catch{continue;}
   if(!r||typeof r!=='object')continue;
   const matched=[...new Set([r.session,r.native_session].filter(x=>typeof x==='string'&&sessions.has(x)))] as string[];
   if(!matched.length)continue;
   const at=Date.parse(r.t);if(!Number.isFinite(at)||at<now-7*86400000||at>now)continue;
   if(typeof r.provider!=='string'||typeof r.model!=='string'||r.provider.length>300||r.model.length>300||!Number.isFinite(r.status))continue;
   const number=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:undefined;
   const decode=nativeDecode(r);
   const item:AgentRequest={id:createHash('sha256').update(line).digest('hex').slice(0,32),at,source:'magpie-session',model:r.provider&&r.model?`${r.provider}/${r.model}`:undefined,
    endedAt:typeof r.ms==='number'&&r.ms>=0?at+r.ms:undefined,status:r.status,completed:r.status>=200&&r.status<400&&!r.err,total_ms:number(r.ms),ttft_ms:r.ttft_ms>0?number(r.ttft_ms):undefined,first_text_ms:r.first_text_ms>0?number(r.first_text_ms):undefined,
    output_tokens:number(r.out),decodeTokensPerSecond:decode,decodeDurationMs:decode===undefined?undefined:r.ms-(r.reasoning>0?(r.first_text_ms>0?r.first_text_ms:r.first_reasoning_ms):r.ttft_ms),reported_model:typeof r.served==='string'&&r.served.length<=300?r.served:undefined};
   const route=typeof r.route_id==='number'&&r.route_id!==0?line.match(/"route_id"\s*:\s*(\d+)/)?.[1]:undefined;
   const previous=route===undefined?undefined:routes.get(route);if(previous?.failed&&!previous.rejected)previous.handedOn=true;
   const entry:Entry={item,sessions:matched,handedOn:r.handed_on===true,failed:r.status>=400||!!r.err,rejected:r.rejected===true,route};
   if(records.length<20000)records.push(entry);
   else{const old=records[cursor]!;old.sessions.forEach(id=>truncated.add(id));if(old.route&&routes.get(old.route)===old)routes.delete(old.route);records[cursor]=entry;cursor=(cursor+1)%20000;}
   if(route!==undefined)routes.set(route,entry);
  }}finally{lines.close();stream.destroy();}
  for(const record of records){if(record.handedOn||record.rejected)continue;for(const session of record.sessions){const list=rows.get(session)??[];list.push(record.item);rows.set(session,list);}}
  for(const [key,list] of rows)rows.set(key,Object.assign(list.sort((a,b)=>a.at-b.at).slice(-5000),{partial:truncated.has(key)||list.length>5000}));
  for(const id of truncated)if(!rows.has(id))rows.set(id,Object.assign([],{partial:true}));
  return rows;
 }
}
export type NativeRequests=AgentRequest[]&{partial?:boolean};
