import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StreamMetrics} from '../src/model-routing/request-metrics.ts';
import {AgentTelemetry,NativeUsageReader,summarizeRequests,type AgentRequest} from '../src/model-routing/agent-telemetry.ts';
import {startModelGateway,type RoutingLease} from '../src/model-routing/gateway.ts';
import {ExecutionJournal} from '../src/model-routing/journal.ts';
const dirs:string[]=[];const scratch=()=>{const d=mkdtempSync(join(tmpdir(),'sck-agent-metrics-'));dirs.push(d);return d;};
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const feed=(m:StreamMetrics,e:unknown)=>m.feed(new TextEncoder().encode(`data: ${JSON.stringify(e)}\r\n\r\n`));
test('stream timing distinguishes headers, thinking, visible text and cumulative output usage, never sums cumulative counters',()=>{
 let now=1000;const m=new StreamMetrics(now,()=>now);now=1100;feed(m,{type:'message_start',message:{model:'served-actual',usage:{input_tokens:100,output_tokens:1}}});
 expect(m.snapshot().ttft_ms).toBeUndefined();now=2000;feed(m,{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'PRIVATE thought'}});
 now=3500;feed(m,{type:'content_block_delta',delta:{type:'text_delta',text:'PRIVATE answer'}});now=4000;feed(m,{type:'message_delta',usage:{output_tokens:200}});feed(m,{type:'message_delta',usage:{output_tokens:240}});feed(m,{type:'message_stop'});m.end();
 expect(m.snapshot()).toMatchObject({ttft_ms:1000,first_text_ms:2500,total_ms:3000,output_tokens:240,input_tokens:100,reported_model:'served-actual'});expect(m.terminal).toBe(true);expect(JSON.stringify(m.snapshot())).not.toContain('PRIVATE');
});
test('SSE chunk boundaries, tool calls, OpenAI/Responses usage and errors preserve unknown measurements',()=>{
 let now=100;const m=new StreamMetrics(0,()=>now);
 const bytes=new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"中文"}}\n\n');
 for(const b of bytes)m.feed(new Uint8Array([b]));expect(m.snapshot().first_text_ms).toBe(100);
 now=200;feed(m,{type:'error',error:{message:'not stored'}});expect(m.failed).toBe(true);
 const tool=new StreamMetrics(0,()=>now);feed(tool,{choices:[{delta:{tool_calls:[{function:{arguments:'{}'}}]}}]});feed(tool,{choices:[],usage:{completion_tokens:30,prompt_tokens:90}});tool.feed(new TextEncoder().encode('data: [DONE]'));tool.end();expect(tool.terminal).toBe(true);expect(tool.snapshot()).toMatchObject({ttft_ms:200,output_tokens:30});expect(tool.snapshot().first_text_ms).toBeUndefined();
 const response=new StreamMetrics(0,()=>now);feed(response,{type:'response.output_text.delta',delta:'hello'});feed(response,{type:'response.completed',response:{model:'real',usage:{output_tokens:4}}});expect(response.snapshot().output_tokens).toBe(4);
 const missing=new StreamMetrics(0,()=>now);feed(missing,{type:'message_stop'});expect(missing.snapshot().ttft_ms).toBeUndefined();expect(missing.snapshot().output_tokens).toBeUndefined();
});
test('per-turn throughput is weighted by measured elapsed time, failures and unknown token counts do not invent measurements',()=>{
 const rows:AgentRequest[]=[{id:'a',at:1,source:'company-gateway',model:'p/a',status:200,completed:true,output_tokens:100,total_ms:1000,ttft_ms:500},{id:'b',at:2,source:'company-gateway',model:'p/b',status:200,completed:true,output_tokens:100,total_ms:9000,ttft_ms:2000},{id:'c',at:3,source:'company-gateway',status:503,completed:false},{id:'d',at:4,source:'company-gateway',status:200}];
 const s=summarizeRequests(rows);expect(s.tokensPerSecond).toBe(20);expect(s.outputTokens).toBe(200);expect(s.requests).toBe(4);expect(s.failed).toBe(1);expect(s.inFlight).toBe(1);expect(s.firstResponseMs).toBe(500);expect(s.decodeTokensPerSecond).toBeUndefined();expect(summarizeRequests([]).tokensPerSecond).toBeUndefined();
});
test('turn IDs may repeat, partial adoption and restart stay separate, progress is numeric and completed rows survive reload',()=>{
 const d=scratch(),s=new AgentTelemetry(d);const a=s.begin('agent','repeat',100);s.record('agent',{id:'a',at:110,status:200,model:'p/a',source:'company-gateway',turnKey:a.key});s.progress('agent','a',{ttft_ms:30});s.complete('agent','a',true,{output_tokens:20,total_ms:100});s.finish('agent','repeat',300);
 const b=s.begin('agent','repeat',400);expect(b.key).not.toBe(a.key);expect(s.view('agent').summary.requests).toBe(0);
 const restored=new AgentTelemetry(d);expect(restored.view('agent',restored.turn('agent',a.key)).summary.outputTokens).toBe(20);expect(restored.current('agent')?.key).toBe(b.key);
 const adopting=s.begin('adopting',null,500,true);s.record('adopting',{id:'early',at:510,status:200,source:'company-gateway',turnKey:adopting.key});
 const adopted=s.begin('adopting','sdk-turn',400,true);expect(adopted.key).toBe(adopting.key);expect(adopted.startedAt).toBe(400);expect(s.view('adopting').summary.requests).toBe(1);
 const older=s.begin('later-sdk',null,500,true);s.record('later-sdk',{id:'before-sdk',at:510,status:200,source:'company-gateway',turnKey:older.key});
 const later=s.begin('later-sdk','new-sdk-turn',600,true);expect(later.key).not.toBe(older.key);expect(s.view('later-sdk').summary.requests).toBe(0);
 const partial=s.begin('other',null,500,true);s.finish('other','actual-turn',600);expect(s.turn('other',partial.key)).toMatchObject({turnId:'actual-turn',endedAt:600,partial:true});
});
test('native log uses exact session identity, safe decode weights and numeric-only output; no cwd or substring guesses',async()=>{
 const file=join(scratch(),'usage.jsonl'),now=Date.now();
 writeFileSync(file,[{session:'exact',provider:'p',model:'real',t:new Date(now-2000).toISOString(),status:200,ms:1500,ttft_ms:500,out:100,folder:'/same/path',providerAccount:'PRIVATE@example.com'}, {session:'other',provider:'p',model:'wrong',t:new Date(now-1000).toISOString(),status:200,ms:500,ttft_ms:100,out:40,folder:'/same/path'}, {session:'exact-extra',provider:'p',model:'wrong2',t:new Date(now-1000).toISOString(),status:200}, {session:'hash',native_session:'exact',provider:'p',model:'native',t:new Date(now-500).toISOString(),status:200,ms:400,ttft_ms:100,out:40}].map(x=>JSON.stringify(x)).join('\n'));
 const rows=await new NativeUsageReader(file).read('exact',now);expect(rows.map(r=>r.model)).toEqual(['p/real','p/native']);expect(rows[0]?.decodeDurationMs).toBe(1000);expect(JSON.stringify(rows)).not.toContain('PRIVATE');expect(JSON.stringify(rows)).not.toContain('/same/path');
});
test('real gateway records numeric metrics through journal, preserves response bytes and marks HTTP errors and cut streams incomplete',async()=>{
 for(const [status,cut] of [[200,false],[503,false],[200,true]] as const){
  const journal=new ExecutionJournal(scratch());const rows:any[]=[];let complete:any[]=[];
  let now=1000;const lease:RoutingLease={agent:'agent',turn_key:'turn',employee:'employee',task:'task',fence:1,role:'engineering',tier:'haiku',phase:'execute'};
  const full='data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"secret response"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\ndata: {"type":"message_stop"}\n\n';
  const text=cut?full.replace('data: {"type":"message_stop"}\n\n',''):full;
  const gateway=await startModelGateway({now:()=>now,lease:async()=>lease,record:async r=>{rows.push(r);await journal.record(r);},complete:async(id,ok,m)=>{complete=[id,ok,m];await journal.complete(id,ok,m);},fetchImpl:(async()=>{now=2000;return new Response(text,{status,headers:{'content-type':'text/event-stream','x-magpie-provider':'p','x-magpie-model':'actual'}});}) as any},0);
  try{const res=await fetch(`http://127.0.0.1:${gateway.port}/a/agent/v1/messages`,{method:'POST',body:JSON.stringify({messages:[{content:'secret prompt'}]})});expect(await res.text()).toBe(text);for(let n=0;n<20&&!complete.length;n++)await Bun.sleep(5);
   expect(rows[0]).toMatchObject({agent:'agent',turn_key:'turn',model:'p/actual'});expect(complete[1]).toBe(status===200&&!cut);expect(complete[2]).toMatchObject({ttft_ms:1000,output_tokens:20,total_ms:1000});
  }finally{await gateway.stop();}
 }
});

test('lifecycle keeps turn measurements without appending verbose turn-end cards',async()=>{
 const {registerAgentMetrics}=await import('../plugin/server/agent-metrics.ts');
 const state=new AgentTelemetry(scratch()),native=new NativeUsageReader(join(scratch(),'missing'));
 const handlers=new Map<string,any>(),rpcs=new Map<string,any>();const appended:any[]=[];
 const server={handle:(rpc:any,handler:any)=>rpcs.set(rpc.name,handler),on:(name:string,h:any)=>{handlers.set(name,h);return ()=>handlers.delete(name);}};
 const paseo={agents:{ref:()=>({refresh:async()=>({agent:{runtimeInfo:{sessionId:'native'},activeTurn:null}}),timeline:{append:async(item:any)=>{appended.push(item);}}})}};
 const event={agent:{id:'agent',provider:'claude'},turnId:'turn'};const stop=registerAgentMetrics(server as any,{state,native});
 handlers.get('agent.turn_started')(event,{paseo});const t=state.current('agent')!;
 state.record('agent',{id:'req',at:Date.now(),turnKey:t.key,model:'p/actual',status:200,source:'company-gateway'});state.complete('agent','req',true,{ttft_ms:1200,total_ms:2000,output_tokens:100});
 const get=rpcs.get('company.agent-model-metrics.get');await expect(get({agentId:'agent'},{paseo,qaSession:true})).rejects.toThrow('QA');
 handlers.get('agent.turn_ended')(event,{paseo});handlers.get('agent.turn_ended')(event,{paseo});
 expect(state.lastTurn('agent')?.endedAt).toBeDefined();
 expect(state.view('agent').summary.tokensPerSecond).toBe(50);
 expect(appended).toHaveLength(0);
 handlers.get('agent.turn_started')({...event,turnId:'next'},{paseo});handlers.get('agent.turn_ended')({...event,turnId:'next'},{paseo});stop();await Bun.sleep(20);expect(appended).toHaveLength(0);
});

test('native retries do not inflate turn requests and stale/completed session bindings do not borrow a newly opened session',async()=>{
 const {readAgentMetrics}=await import('../plugin/server/agent-metrics.ts');const d=scratch(),file=join(d,'usage.jsonl');const now=Date.now();
 const row=(id:string,status:number,at:number)=>JSON.stringify({route_id:'PLACEHOLDER',session:'native',t:new Date(at).toISOString(),provider:'p',model:'real',status,ms:100,out:2}).replace('"PLACEHOLDER"',id);
 writeFileSync(file,[row('9007199254740992',503,now-1000),row('9007199254740992',200,now-500)].join('\n'));
 const state=new AgentTelemetry(join(d,'state')),native=new NativeUsageReader(file),turn=state.begin('agent','old',now-2000);state.bindSession('agent',turn.key,'native');state.finish('agent','old',now);
 const paseo={agents:{ref:()=>({refresh:async()=>({agent:{runtimeInfo:{sessionId:'new-session'},activeTurn:null}})})}};
 const view=await readAgentMetrics('agent',paseo as any,turn,true,{state,native});expect(view.summary.requests).toBe(1);expect(view.latest?.model).toBe('p/real');
 const next=state.begin('agent','new',now+1,false,true);expect(next.key).not.toBe(turn.key);
 // Without a known old session, a newer turn cannot supply its session to an older summary.
 const unknown=state.begin('other','old',now-2000);state.finish('other','old',now);state.begin('other','new',now+1,false,true);
 expect((await readAgentMetrics('other',paseo as any,unknown,true,{state,native})).source).toBe('unavailable');
});

test('pre-header connection failure is a failed measured attempt and never invents an actual model',async()=>{
 const rows:any[]=[],completions:any[]=[];let now=100;
 const gateway=await startModelGateway({now:()=>now,lease:async()=>({agent:'agent',employee:'e',task:'t',fence:1,role:'engineering',tier:'haiku',phase:'execute'}),record:async r=>{rows.push(r);},complete:async(...args)=>{completions.push(args);},fetchImpl:(async()=>{now=900;throw Error('connection closed');}) as any},0);
 try{const reply=await fetch(`http://127.0.0.1:${gateway.port}/a/agent/v1/messages`,{method:'POST',body:'{"messages":[]}'});expect(reply.status).toBe(502);await reply.text();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({agent:'agent',status:502,model:null});expect(completions[0]).toMatchObject([rows[0].id,false,{total_ms:800}]);expect(completions[0][2].ttft_ms).toBeUndefined();}finally{await gateway.stop();}
});

test('finished summary latest stays in its own turn while panel latest may follow the next turn',async()=>{
 const {readAgentMetrics}=await import('../plugin/server/agent-metrics.ts');const now=Date.now(),dir=scratch(),state=new AgentTelemetry(join(dir,'state')),file=join(dir,'usage.jsonl'),native=new NativeUsageReader(file);
 const first=state.begin('agent','a',now-2000);state.record('agent',{id:'old',at:now-1500,model:'p/old',status:200,source:'company-gateway',turnKey:first.key});state.finish('agent','a',now-1000);
 const second=state.begin('agent','b',now-500);state.record('agent',{id:'new',at:now-100,model:'p/new',status:200,source:'company-gateway',turnKey:second.key});
 expect(state.view('agent',first,true).latest?.id).toBe('old');expect(state.view('agent',first).latest?.id).toBe('new');
 const t=state.begin('native','a',now-2000);state.bindSession('native',t.key,'session');state.finish('native','a',now-1000);state.begin('native','b',now-500);
 writeFileSync(file,[{session:'session',t:new Date(now-1500),provider:'p',model:'old',status:200},{session:'session',t:new Date(now-100),provider:'p',model:'new',status:200}].map(x=>JSON.stringify(x)).join('\n'));
 const paseo={agents:{ref:()=>({refresh:async()=>({agent:{runtimeInfo:{sessionId:'session'}}})})}};
 expect((await readAgentMetrics('native',paseo as any,t,true,{state,native})).latest?.model).toBe('p/old');
});

test('native scan bounds retained records and session cache and marks truncated data partial',async()=>{
 const file=join(scratch(),'usage.jsonl'),now=Date.now(),row=(session:string,i:number)=>JSON.stringify({session,t:new Date(now-30000+i),provider:'p',model:'m',status:200,ms:1,out:1});
 writeFileSync(file,Array.from({length:20002},(_,i)=>row(i%2?'a':'b',i)).join('\n'));
 const reader=new NativeUsageReader(file);await reader.read('a',now);const rows=await reader.read('b',now,true);
 expect(rows).toHaveLength(5000);expect(rows.partial).toBe(true);
 expect((reader as any).cached.rows.size).toBe(2);
 writeFileSync(file,[row('b',0),...Array.from({length:20000},(_,i)=>row('a',i+1))].join('\n'));
 const evicted=await reader.read('b',now,true);expect(evicted).toHaveLength(0);expect(evicted.partial).toBe(true);
 writeFileSync(file,'');for(let i=0;i<66;i++)await reader.read(`session-${i}`,now,true);
 expect((reader as any).sessions.size).toBe(64);expect((reader as any).cached.sessions.size).toBe(64);
 const many=summarizeRequests(Array.from({length:51},(_,i)=>({id:String(i),at:i,status:200,source:'company-gateway' as const,model:`p/${i}`})));expect(many.models).toHaveLength(50);expect(many.partial).toBe(true);expect(many.requests).toBe(51);
});
