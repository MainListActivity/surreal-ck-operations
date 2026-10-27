import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {summarizeRequests,type AgentRequest,type MetricsSummary} from './vendor/src/model-routing/agent-telemetry';
import {modelSwitchSchema,type ModelSwitch} from '../shared/model-switch';
export interface SwitchItem {id:string;data:ModelSwitch}
interface Cursor {session:string;model:string;start:number;at:number;id:string;sequence:number;partial:boolean;current?:MetricsSummary;pending:SwitchItem[]}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,32);
const actual=(r:AgentRequest)=>r.model&&!/(?:^|\/)group\//.test(r.model)&&r.model!=='unknown'&&r.status>=200&&r.status<300&&r.completed!==false&&(r.completed===true||r.ttft_ms!==undefined);
const respondedAt=(r:AgentRequest)=>r.at+(r.ttft_ms??r.total_ms??0);
function measured(segment:AgentRequest[],partial:boolean,enrich?:AgentRequest[]):MetricsSummary {
 const summary=summarizeRequests(segment,partial);
 // Native decode timing is authoritative; gateway throughput retains its own measured durations.
 if(enrich){
  const used=new Set<string>(),native:AgentRequest[]=[];
  for(const local of segment.filter(x=>x.completed===true)){
   const matches=enrich.filter(x=>!used.has(x.id)&&x.model===local.model&&x.output_tokens===local.output_tokens&&Math.abs(x.at-local.at)<=2000).sort((a,b)=>Math.abs(a.at-local.at)-Math.abs(b.at-local.at));
   if(matches[0]&&(!matches[1]||Math.abs(matches[0].at-local.at)<Math.abs(matches[1].at-local.at))){used.add(matches[0].id);native.push(matches[0]);}
  }
  summary.decodeTokensPerSecond=summarizeRequests(native).decodeTokensPerSecond;
 }
 return summary;
}
/** Durable cursors and a retry outbox. Transcript text, credentials and account identities never enter this file. */
export class ModelSwitchTracker {
 constructor(private dir:string){mkdirSync(dir,{recursive:true,mode:0o700});}
 private path(agent:string){return join(this.dir,hash(agent)+'.json');}
 private load(agent:string):Cursor|undefined {try{const c=JSON.parse(readFileSync(this.path(agent),'utf8'));if(typeof c.session==='string'&&typeof c.model==='string'&&Number.isFinite(c.at)&&Array.isArray(c.pending))return c;}catch{}return;}
 private save(agent:string,c:Cursor){const p=this.path(agent);writeFileSync(p+'.tmp',JSON.stringify(c),{mode:0o600});renameSync(p+'.tmp',p);}
 observe(agent:string,session:string,input:AgentRequest[],partial=false,enrich?:AgentRequest[]):SwitchItem[]{
  const rows=input.filter(actual).sort((a,b)=>respondedAt(a)-respondedAt(b)||a.id.localeCompare(b.id));
  let c=this.load(agent);
  if(!rows.length)return c?.pending??[];
  if(!c){
   // Adopt the current segment without replaying historical switches into today's timeline.
   const latest=rows.at(-1)!;let start=rows.length-1;while(start>0&&rows[start-1]!.model===latest.model)start--;
   c={session,model:latest.model!,start:respondedAt(rows[start]!),at:respondedAt(latest),id:latest.id,sequence:0,partial:partial||start===0,pending:[]};
   c.current=measured(rows.slice(start),c.partial,enrich);
   this.save(agent,c);return [];
  }
  if(c.session!==session){c.session=session;c.partial=true;}
  for(const r of rows){
   const responseAt=respondedAt(r);
   if(responseAt<c.at||(responseAt===c.at&&r.id.localeCompare(c.id)<=0))continue;
   if(r.model!==c.model){
    const segment=input.filter(x=>x.model===c!.model&&actual(x)&&respondedAt(x)>=c!.start&&respondedAt(x)<responseAt);
    const summary=segment.length?measured(segment,c.partial||partial,enrich):c.current??summarizeRequests([],true);
    c.sequence++;
    c.pending.push({id:`model-switch-${hash(agent+'\0'+session)}-${c.sequence}`,data:modelSwitchSchema.parse({from:c.model,to:r.model,at:responseAt,previous:summary})});
    c.model=r.model!;c.start=responseAt;c.partial=false;
   }
   c.at=responseAt;c.id=r.id;
  }
  const current=rows.filter(x=>x.model===c!.model&&respondedAt(x)>=c!.start);
  if(current.length)c.current=measured(current,c.partial||partial,enrich);
  // Bound work when a client was offline for a long time; mark a truncated replay explicitly.
  if(c.pending.length>100){c.pending=c.pending.slice(-100);for(const p of c.pending)p.data.previous.partial=true;}
  this.save(agent,c);return c.pending;
 }
 acknowledge(agent:string,id:string){const c=this.load(agent);if(c){c.pending=c.pending.filter(p=>p.id!==id);this.save(agent,c);}}
}
