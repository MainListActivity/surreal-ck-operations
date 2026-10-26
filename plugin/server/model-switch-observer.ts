import {statSync} from 'node:fs';
import type {PaseoApi} from '@getpaseo/client';
import type {AgentTelemetry,NativeUsageReader} from './vendor/src/model-routing/agent-telemetry';
import {ModelSwitchTracker} from './model-switch-tracker';
interface Options {
 state:Pick<AgentTelemetry,'requests'|'subscribe'|'view'>;
 native:Pick<NativeUsageReader,'read'>;
 dir:string;file:string;intervalMs?:number;
}
/** Background observation only: no DB, RPC or disk scan is awaited on the inference path. */
export function observeModelSwitches(io:Options){
 const tracker=new ModelSwitchTracker(io.dir),agents=new Map<string,{session:string;paseo:PaseoApi}>();
 const busy=new Map<string,Promise<void>>(),dirty=new Set<string>();
 let active=true,discovered=false,signature='';
 const run=(id:string)=>{
  if(!active||!agents.has(id))return Promise.resolve();
  dirty.add(id);const pending=busy.get(id);if(pending)return pending;
  const work=Promise.resolve().then(async()=>{
   while(active&&dirty.delete(id)){
    const binding=agents.get(id);if(!binding)break;
    const local=io.state.view(id),native=await io.native.read(binding.session).catch(()=>undefined);
    if(!active||agents.get(id)!==binding)break;
    const rows=local.gatewaySeen?io.state.requests(id):native??[];
    const events=tracker.observe(id,binding.session,rows,local.gatewaySeen?local.summary.partial:native?.partial??true,local.gatewaySeen?native:undefined);
    for(const item of events){
     if(!active||agents.get(id)!==binding)break;
     await binding.paseo.agents.ref(id).timeline.append({type:'plugin',kind:'sck-model-switch',version:1,id:item.id,data:item.data});
     if(active)tracker.acknowledge(id,item.id);
    }
   }
  }).catch(()=>{if(active)dirty.add(id);console.warn('model switch timeline: observation deferred');}).finally(()=>busy.delete(id));
  busy.set(id,work);return work;
 };
 const watch=async(id:string,paseo:PaseoApi)=>{
  if(!active)return;
  const snapshot=await paseo.agents.ref(id).refresh();if(!active||!snapshot)return;
  const session=snapshot.agent.runtimeInfo?.sessionId??snapshot.agent.persistence?.sessionId;
  if(!session)return;
  const old=agents.get(id);
  if(!old||old.session!==session){agents.delete(id);agents.set(id,{session,paseo});}
  if(agents.size>64){const oldest=agents.keys().next().value!;agents.delete(oldest);dirty.delete(oldest);}
  await run(id);
 };
 const connect=(id:string,paseo:PaseoApi)=>{
  const watching=watch(id,paseo).catch(()=>{});
  if(!discovered){discovered=true;
   // The first official plugin context also adopts sessions already running during reload.
   void paseo.agents.list({filter:{statuses:['running','initializing'],includeArchived:false},page:{limit:64}})
    .then(page=>Promise.allSettled(page.entries.map(e=>watch(e.agent.id,paseo))))
    .catch(()=>{discovered=false;});
  }
  return watching;
 };
 const unsubscribe=io.state.subscribe(id=>{void run(id);});
 const timer=setInterval(()=>{
  if(!active||!agents.size)return;
  // Avoid repeatedly scanning a large unchanged Magpie log when the company is idle.
  let next='';try{const s=statSync(io.file);next=`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;}catch{}
  if(next===signature&&!dirty.size)return;signature=next;
  for(const id of agents.keys())void run(id);
 },io.intervalMs??5000);
 timer.unref?.();
 return {connect,flush:run,forget:(id:string)=>{agents.delete(id);dirty.delete(id);},stop:()=>{active=false;clearInterval(timer);unsubscribe();agents.clear();dirty.clear();}};
}
