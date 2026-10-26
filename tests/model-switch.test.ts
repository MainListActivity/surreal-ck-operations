import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ModelSwitchTracker} from '../plugin/server/model-switch-tracker';
import {observeModelSwitches} from '../plugin/server/model-switch-observer';
import {AgentTelemetry,type AgentRequest} from '../src/model-routing/agent-telemetry';
const dirs:string[]=[];const scratch=()=>{const p=mkdtempSync(join(tmpdir(),'sck-model-switch-'));dirs.push(p);return p;};
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
const row=(id:string,at:number,model='p/a',extra:Partial<AgentRequest>={}):AgentRequest=>({id,at,model,status:200,completed:true,source:'company-gateway',total_ms:1000,output_tokens:100,ttft_ms:100,...extra});
test('switches actual response models across turns, with weighted previous-segment speed and native decode enrichment',()=>{
 const tracker=new ModelSwitchTracker(scratch()),a=row('a',100),b=row('b',200,'p/a',{total_ms:9000}),c=row('c',300,'p/b',{completed:undefined});
 expect(tracker.observe('agent','session',[a])).toEqual([]);
 expect(tracker.observe('agent','session',[a,b])).toEqual([]);
 const [switch1]=tracker.observe('agent','session',[a,b,c],false,[row('n1',101,'p/a',{decodeTokensPerSecond:50,decodeDurationMs:2000}),row('n2',201,'p/a',{decodeTokensPerSecond:100,decodeDurationMs:1000})]);
 expect(switch1!.data).toMatchObject({from:'p/a',to:'p/b',at:400,previous:{successful:2,requests:2,tokensPerSecond:20,outputTokens:200}});
 expect(switch1!.data.previous.decodeTokensPerSecond).toBeCloseTo(200/3);
 tracker.acknowledge('agent',switch1!.id);
 expect(tracker.observe('agent','session',[a,b,{...c,completed:true}])).toEqual([]);
 const [back]=tracker.observe('agent','session',[a,b,{...c,completed:true},row('d',400)]);
 expect(back!.data).toMatchObject({from:'p/b',to:'p/a',previous:{successful:1,tokensPerSecond:100,partial:false}});
});
test('failures, unknown/group labels and response-less candidates never become switches; late old requests do not flip back',()=>{
 const tracker=new ModelSwitchTracker(scratch()),a=row('a',100);
 tracker.observe('agent','session',[a]);
 const ignored=[row('fail',200,'p/b',{completed:false,status:503}),row('unknown',210,'unknown'),row('group',220,'remote/group/sck-haiku'),row('waiting',230,'p/b',{completed:undefined,ttft_ms:undefined})];
 expect(tracker.observe('agent','session',[a,...ignored])).toEqual([]);
 const b=row('b',300,'p/b');const [change]=tracker.observe('agent','session',[a,...ignored,b]);tracker.acknowledge('agent',change!.id);
 expect(tracker.observe('agent','session',[a,row('late',250),b])).toEqual([]);
 expect(tracker.observe('agent','other-native-session',[row('new',400,'p/c')])[0]!.data).toMatchObject({from:'p/b',to:'p/c'});
});
test('historical adoption is quiet, append retries retain the same ID and restart does not duplicate acknowledged switches',()=>{
 const dir=scratch(),a=row('a',100),b=row('b',200,'p/b'),c=row('c',300,'p/c');
 const first=new ModelSwitchTracker(dir);expect(first.observe('agent','session',[a,b])).toEqual([]);
 const [event]=first.observe('agent','session',[a,b,c]);
 const restarted=new ModelSwitchTracker(dir);expect(restarted.observe('agent','session',[a,b,c])).toEqual([event]);
 restarted.acknowledge('agent',event!.id);
 expect(new ModelSwitchTracker(dir).observe('agent','session',[a,b,c])).toEqual([]);
 expect(new ModelSwitchTracker(dir).observe('other-agent','session',[a,b,c])).toEqual([]);
});
test('missing measurements stay unknown instead of inventing zero speed',()=>{
 const tracker=new ModelSwitchTracker(scratch()),a=row('a',100,'p/a',{output_tokens:undefined,total_ms:undefined});
 tracker.observe('agent','session',[a]);const [event]=tracker.observe('agent','session',[a,row('b',200,'p/b')]);
 expect(event!.data.previous.tokensPerSecond).toBeUndefined();expect(event!.data.previous.decodeTokensPerSecond).toBeUndefined();
 expect(event!.data.previous.outputTokens).toBeUndefined();
});
test('gateway first-response notification appends before turn end; repeated progress is quiet and teardown stops appends',async()=>{
 const dir=scratch(),state=new AgentTelemetry(join(dir,'ledger'));let native:AgentRequest[]=[];const appended:any[]=[];
 const paseo={agents:{list:async()=>({entries:[]}),ref:()=>({refresh:async()=>({agent:{runtimeInfo:{sessionId:'native'}}}),timeline:{append:async(x:any)=>{appended.push(x);}}})}};
 const observer=observeModelSwitches({state,native:{read:async()=>native},dir:join(dir,'switches'),file:join(dir,'missing'),intervalMs:20});
 try{
  state.begin('agent','active-turn');state.record('agent',row('a',100));await observer.connect('agent',paseo as any);
  state.record('agent',row('b',200,'p/b',{completed:undefined,ttft_ms:undefined}));await observer.flush('agent');expect(appended).toHaveLength(0);
  state.progress('agent','b',{ttft_ms:50});await observer.flush('agent');expect(state.current('agent')).toBeDefined();
  expect(appended).toHaveLength(1);expect(appended[0]).toMatchObject({kind:'sck-model-switch',data:{from:'p/a',to:'p/b',previous:{tokensPerSecond:100}}});
  state.progress('agent','b',{total_ms:100});state.complete('agent','b',true);await observer.flush('agent');expect(appended).toHaveLength(1);
  observer.stop();state.record('agent',row('c',300,'p/c'));await observer.flush('agent');expect(appended).toHaveLength(1);
 }finally{observer.stop();}
});
test('native direct sessions publish within an active turn and failed appends retry with one stable timeline ID',async()=>{
 const dir=scratch(),state=new AgentTelemetry(join(dir,'ledger'));let rows=[row('a',100)];let fail=true;const attempts:any[]=[];
 const paseo={agents:{list:async()=>({entries:[]}),ref:()=>({refresh:async()=>({agent:{persistence:{sessionId:'native'}}}),timeline:{append:async(x:any)=>{attempts.push(x);if(fail)throw Error('offline');}}})}};
 const observer=observeModelSwitches({state,native:{read:async()=>rows},dir:join(dir,'switches'),file:join(dir,'missing'),intervalMs:10000});
 try{await observer.connect('agent',paseo as any);rows=[...rows,row('b',200,'p/b')];await observer.flush('agent');
  expect(attempts).toHaveLength(1);fail=false;await observer.flush('agent');expect(attempts).toHaveLength(2);expect(attempts[0].id).toBe(attempts[1].id);
  await observer.flush('agent');expect(attempts).toHaveLength(2);
 }finally{observer.stop();}
});

test('native log changes are observed by the background sampler without a panel or end-of-turn event',async()=>{
 const dir=scratch(),file=join(dir,'usage.jsonl'),state=new AgentTelemetry(join(dir,'ledger'));writeFileSync(file,'a');
 let rows=[row('a',100)];const appended:any[]=[];
 const paseo={agents:{list:async()=>({entries:[]}),ref:()=>({refresh:async()=>({agent:{runtimeInfo:{sessionId:'native'}}}),timeline:{append:async(x:any)=>{appended.push(x);}}})}};
 const observer=observeModelSwitches({state,native:{read:async()=>rows},dir:join(dir,'switches'),file,intervalMs:10});
 try{
  await observer.connect('agent',paseo as any);
  rows=[...rows,row('b',200,'p/b')];writeFileSync(file,'new-record');
  for(let i=0;i<50&&!appended.length;i++)await Bun.sleep(5);
  expect(appended).toHaveLength(1);expect(appended[0].data).toMatchObject({from:'p/a',to:'p/b'});
 }finally{observer.stop();}
});

test('concurrent calls follow first-response order rather than request start order',()=>{
 const tracker=new ModelSwitchTracker(scratch()),baseline=row('base',0,'p/a',{ttft_ms:1});
 tracker.observe('agent','session',[baseline]);
 const quick=row('quick',200,'p/b',{ttft_ms:10,completed:undefined});
 const slow=row('slow',100,'p/a',{ttft_ms:1000,completed:undefined});
 const [first]=tracker.observe('agent','session',[baseline,quick]);tracker.acknowledge('agent',first!.id);
 const [second]=tracker.observe('agent','session',[baseline,quick,slow]);
 expect(second!.data).toMatchObject({from:'p/b',to:'p/a',at:1100});
});


test('a native session reset preserves the previous model speed within the same Paseo conversation',()=>{
 const dir=scratch(),tracker=new ModelSwitchTracker(dir),old=[row('a',100,'p/a',{output_tokens:120,total_ms:2000})];
 tracker.observe('agent','old-native',old,false,[row('native-a',101,'p/a',{output_tokens:120,decodeTokensPerSecond:80,decodeDurationMs:1500})]);
 const restored=new ModelSwitchTracker(dir);
 expect(restored.observe('agent','new-native',[])).toEqual([]);
 const [event]=restored.observe('agent','new-native',[row('b',3000,'p/b')]);
 expect(event!.data).toMatchObject({from:'p/a',to:'p/b',previous:{successful:1,tokensPerSecond:60,decodeTokensPerSecond:80}});
 restored.acknowledge('agent',event!.id);
 expect(restored.observe('agent','new-native',[row('b',3000,'p/b')])).toEqual([]);
});
