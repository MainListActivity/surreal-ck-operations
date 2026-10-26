import {join} from 'node:path';import {homedir} from 'node:os';
import type {PluginServerContext} from '@getpaseo/plugin/server';
import type {PaseoApi} from '@getpaseo/client';
import {AgentTelemetry,NativeUsageReader,summarizeRequests,type AgentTurn} from './vendor/src/model-routing/agent-telemetry.ts';
import {agentMetrics,agentMetricsViewSchema,type AgentMetricsView} from '../shared/agent-metrics';
import {observeModelSwitches} from './model-switch-observer';
import {serviceHome} from './env';import {isQaContext} from './owner-context';
let store:AgentTelemetry|undefined;
const native=new NativeUsageReader(join(homedir(),'.config/magpie/usage.jsonl'));
export const telemetry=()=>store??=new AgentTelemetry(join(serviceHome(),'model-routing','agent-metrics'));

interface MetricsRuntime {
 state:Pick<AgentTelemetry,'lastTurn'|'begin'|'view'|'current'|'bindSession'|'finish'|'requests'|'subscribe'>;
 native:Pick<NativeUsageReader,'read'>;
 switches?:{dir:string;file:string;intervalMs?:number};
}
const runtime=():MetricsRuntime=>({state:telemetry(),native,switches:{dir:join(serviceHome(),'model-routing','model-switches'),file:join(homedir(),'.config/magpie/usage.jsonl')}});
export async function readAgentMetrics(agentId:string,paseo:PaseoApi,turn?:AgentTurn,force=false,io:MetricsRuntime=runtime()):Promise<AgentMetricsView>{
 const turnOnly=turn!==undefined;
 const ref=paseo.agents.ref(agentId),snapshot=await ref.refresh();if(!snapshot)throw Error('agent not found');
 const state=io.state;
 if(!turn){turn=state.lastTurn(agentId);const active=snapshot.agent.activeTurn;
  if(active&&(!turn||turn.endedAt!==undefined||turn.turnId!==active.turnId))turn=state.begin(agentId,active.turnId,active.startedAt?Date.parse(active.startedAt):Date.now(),true);
 }
 const local=state.view(agentId,turn,turnOnly);
 if(local.gatewaySeen)return agentMetricsViewSchema.parse({agentId,source:'company-gateway',...local,updatedAt:Date.now(),note:'首响应含思考/工具；首文字单列。输出吞吐=已完成请求输出token总量÷其请求总耗时，含等待；公司网关未取得可靠解码计时时生成速度显示未知。'});
 const runtimeSession=snapshot.agent.runtimeInfo?.sessionId??snapshot.agent.persistence?.sessionId;
 const superseded=turn?.endedAt!==undefined&&state.current(agentId)?.key!==undefined&&state.current(agentId)?.key!==turn.key;
 const session=turn?.sessionId??(!superseded?runtimeSession:undefined);
 if(turn&&session)state.bindSession(agentId,turn.key,session);
 if(!session)return agentMetricsViewSchema.parse({agentId,source:'unavailable',turn,summary:summarizeRequests([],true),updatedAt:Date.now(),note:'此会话未提供原生 sessionId，无法精确匹配；不按目录猜测。'});
 try{
  const rows=await io.native.read(session,Date.now(),force),selected=turn?rows.filter(r=>r.at>=turn.startedAt&&r.at<(turn.endedAt??Infinity)):[];
  return agentMetricsViewSchema.parse({agentId,source:'magpie-session',turn,latest:(turnOnly?selected:rows).at(-1),summary:summarizeRequests(selected,(turn?.partial??true)||rows.partial===true||!!(turn&&turn.startedAt<Date.now()-7*86400000)),updatedAt:Date.now(),note:'按原生sessionId精确匹配；首响应含思考/工具，首文字单列。仅包含已落日志的请求，进行中请求未知。输出吞吐含等待；生成速度沿用Magpie原生解码与排除规则。'});
 }catch{return agentMetricsViewSchema.parse({agentId,source:'unavailable',turn,summary:summarizeRequests([],true),updatedAt:Date.now(),note:'Magpie本机用量日志暂不可读；未知不等于零。'});}
}
export function registerAgentMetrics(server:PluginServerContext,io:MetricsRuntime=runtime()){
 const state=io.state;
 const switches=io.switches?observeModelSwitches({...io.switches,state,native:io.native}):undefined;
 server.handle(agentMetrics,async({agentId},context)=>{if(isQaContext(context))throw Error('owner metrics are not available to QA sessions');switches?.connect(agentId,context.paseo);return readAgentMetrics(agentId,context.paseo,undefined,false,io);});
 const offs=[server.on('agent.turn_started',(event,{paseo})=>{
  switches?.connect(event.agent.id,paseo);
  let turn:AgentTurn;try{turn=state.begin(event.agent.id,event.turnId,Date.now(),false,true);}catch{console.warn("agent model metrics: start observation unavailable");return;}
  void paseo.agents.ref(event.agent.id).refresh().then(s=>{const id=s?.agent.runtimeInfo?.sessionId??s?.agent.persistence?.sessionId;if(id&&state.current(event.agent.id)?.key===turn.key)state.bindSession(event.agent.id,turn.key,id);}).catch(()=>{});
 }),server.on('agent.turn_ended',(event,{paseo})=>{
  try{state.finish(event.agent.id,event.turnId);}catch{console.warn("agent model metrics: end observation unavailable");}
  switches?.connect(event.agent.id,paseo);
 }),server.on('agent.archived',event=>switches?.forget(event.agent.id))];
 return ()=>{switches?.stop();offs.forEach(off=>off());};
}
