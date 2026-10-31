import {expect,test} from 'bun:test';
import {observeRuntimeIdle,reclaimMemoryLru} from '../src/dispatcher/memory-lru.ts';
import {closePaseoRuntime} from '../src/dispatcher/runtime-sleep.ts';
import type {EmployeeInst,Workforce,SupervisedTask} from '../src/workforce.ts';

const inst=(id:string,since?:number):EmployeeInst=>({id,role:'engineering',paseoAgentId:`agent-${id}`,workspaceScope:'goal',idleSince:since,lastWakeAt:1});
function world(instances:EmployeeInst[]){
 const states=new Map(instances.map(i=>[i.id,'idle'])),closed:string[]=[],released:string[]=[],reserved:string[]=[];
 const tasks:SupervisedTask[]=[],wakes:any[]=[];let status='idle',permissions=0,unreadable=false,failClose=false;
 const wf={insts:async()=>instances,tasks:async()=>tasks,openManagerWakes:async()=>{if(unreadable)throw Error('unreadable');return wakes},reserveRuntimeSleep:async(i:EmployeeInst)=>{reserved.push(i.id);return true},releaseRuntimeSleep:async(id:string)=>{released.push(id)}} as unknown as Workforce;
 const paseo={status:async(id:string)=>({status:closed.includes(id)?'closed':status,pendingPermissions:permissions}),sleep:async(id:string)=>{if(failClose)throw Error('timeout');closed.push(id)}};
 return {instances,states,closed,released,reserved,tasks,wakes,paseo,wf,setStatus:(s:string,p=0)=>{status=s;permissions=p},setUnreadable:()=>{unreadable=true},setFail:()=>{failClose=true},run:()=>reclaimMemoryLru({instances,states,now:10000,workforce:wf,paseo,log:()=>{}})};
}
test('LRU closes only the oldest eligible runtime per pass, including bound goal conversations',async()=>{
 const f=world([inst('new',6000),inst('old',1000),inst('middle',5000)]);
 expect((await f.run())?.id).toBe('old');expect(f.closed).toEqual(['agent-old']);expect(f.released).toEqual(['old']);
 expect(f.instances[0].paseoAgentId).toBe('agent-new');
});
test('one hour is a hard floor, unknown idle age and fresh wakes are protected',async()=>{
 const fresh=inst('fresh',1000);fresh.lastWakeAt=9999;
 const f=world([inst('3599-seconds',6401),inst('unknown'),fresh]);expect(await f.run()).toBeUndefined();expect(f.closed).toEqual([]);
 const edge=world([inst('3600-seconds',6400)]);expect((await edge.run())?.id).toBe('3600-seconds');
});
test('leases, pending manager work, permission prompts, running and unreadable states prevent closure',async()=>{
 for(const mode of ['task','activeTask','wake','permissions','running','unknown','unreadable'] as const){
  const f=world([inst('old',1000)]);
  if(mode==='task')f.tasks.push({currentEmployee:'old'} as SupervisedTask);
  if(mode==='activeTask')f.instances[0].activeTask='task';
  if(mode==='wake')f.wakes.push({agent:'agent-old'});
  if(mode==='permissions')f.setStatus('idle',1);
  if(mode==='running'||mode==='unknown')f.setStatus(mode);
  if(mode==='unreadable')f.setUnreadable();
  expect(await f.run()).toBeUndefined();expect(f.closed).toEqual([]);
 }
});
test('an uncertain close keeps the claim barrier and does not close a second employee',async()=>{
 const f=world([inst('old',1000),inst('next',2000)]);f.setFail();expect(await f.run()).toBeUndefined();expect(f.reserved).toEqual(['old']);expect(f.released).toEqual([]);
});
test('continuous idle observations include goals, clear busy or leased timers and do not borrow process age',async()=>{
 const a=inst('idle'),b=inst('busy',1000),c=inst('held',2000);let rows:any[]=[];
 await observeRuntimeIdle({instances:[a,b,c],states:new Map([['idle','idle'],['busy','busy'],['held','idle']]),tasks:[{currentEmployee:'held'} as SupervisedTask],now:10000,workforce:{observeSessionIdle:async o=>{rows=o}}});
 expect(a.idleSince).toBe(10000);expect(b.idleSince).toBeUndefined();expect(c.idleSince).toBeUndefined();expect(rows.find(r=>r.id==='busy').previousIdleSince).toBe(1000);
});
test('native MCP adapter invokes runtime-close only and rejects remote endpoints',async()=>{
 const calls:any[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  if(req.method==='GET')return new Response(null,{status:405});
  const body=await req.json() as any;
  if(body.id===undefined)return new Response(null,{status:202});
  const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:(calls.push(body.params),{content:[],structuredContent:{success:true}});
  return Response.json({jsonrpc:'2.0',id:body.id,result});
 }});
 try{await closePaseoRuntime('agent-fixture',`http://127.0.0.1:${server.port}/mcp/agents`);expect(calls).toEqual([{name:'kill_agent',arguments:{agentId:'agent-fixture'}}]);await expect(closePaseoRuntime('x','https://example.com/mcp')).rejects.toThrow('local owner');}finally{server.stop(true)}
});
