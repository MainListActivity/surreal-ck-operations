import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bundled from '../src/model-routing/benchmarks.json';
import {useBenchmarks,aaRankOf,classify} from '../src/model-routing/policy.ts';
import {parseAaLeaderboard,refreshAa,loadAa} from '../src/model-routing/aa.ts';
import {parseCsv,usageStats,quotaAccounts,modelFacts,jevOrder,RankingRefresher,saveRankingSettings,rankingSettings} from '../src/model-routing/ranking.ts';
import {ModelRoutingController} from '../src/model-routing/controller.ts';
import {startModelGateway} from '../src/model-routing/gateway.ts';
const dirs:string[]=[];
const scratch=()=>{const p=mkdtempSync(join(tmpdir(),'sck-ranking-'));dirs.push(p);return p;};
afterEach(()=>{useBenchmarks(bundled.models);for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const flight=(rows:unknown[])=>`<script>self.__next_f.push(${JSON.stringify([1,`data:{"initialModels":${JSON.stringify(rows)},"x":1}`])})</script>`;
const fact=(id:string)=>({id,accounts:[],price:{free:false}});
const response=(questions:Record<string,unknown>)=>({model:'fixture',answers:Object.fromEntries(Object.keys(questions).map((k,i)=>[k,{type:'score' as const,score:i%5,confidence:0.95}]))});

test('AA flight parser preserves prices, escapes and estimates, ignores deprecated/unscored rows',()=>{
 expect(parseAaLeaderboard(flight([{slug:'a',intelligenceIndex:40,price1mInputTokens:2,price1mOutputTokens:8,cacheHitPrice:0.2,intelligenceIndexIsEstimated:true,note:'a ] escaped " b'},{slug:'old',intelligenceIndex:99,deprecated:true},{slug:'unknown'}]))).toEqual([{slug:'a',score:40,estimated:true,priceInput:2,priceOutput:8,priceCacheHit:0.2}]);
 expect(parseAaLeaderboard('not a leaderboard')).toEqual([]);
});
test('AA refresh is daily, atomic and retains last good snapshot on bad response',async()=>{
 const file=join(scratch(),'aa.json');let calls=0;
 const rows=[{slug:'deepseek-v4-1-flash-1017',intelligenceIndex:45},{slug:'claude-sonnet-5-5',intelligenceIndex:56},...Array.from({length:55},(_,i)=>({slug:`m-${i}`,intelligenceIndex:i}))];
 const fetcher=(async()=>{calls++;return new Response(flight(rows));}) as unknown as typeof fetch;
 const now=Date.now();const a=await refreshAa(file,fetcher,now);expect(a?.models).toHaveLength(57);
 await refreshAa(file,fetcher,now+1000);expect(calls).toBe(1);
 expect(await refreshAa(file,(async()=>new Response('broken')) as unknown as typeof fetch,now+86400001)).toEqual(a);
 expect(loadAa(file)).toEqual(a);
});
test('daily benchmark supplies rank, future models and anchor classification',()=>{
 useBenchmarks([{slug:'deepseek-v4-1-flash-1017',score:45},{slug:'claude-sonnet-5-5',score:56},{slug:'future',score:49},{slug:'weak',score:37}]);
 expect(aaRankOf('future')).toBe(2);expect(classify([{id:'p/future'},{id:'p/weak'}]).map(x=>[x.id,x.tier])).toEqual([['p/future','opus']]);
});
test('usage parses quoted CSV, caches, decode speed and rejects failed or unidentified calls',()=>{
 const csv='served_model,status,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,duration_ms,ttft_ms,error\r\na/model,200,10,80,10,100,1500,500,"comma, and ""quote"""\r\nb/model,200,10,80,10,200,2500,500,\r\na/model,429,0,0,0,1000,1,0,\r\n,200,100,0,0,10,1000,0,';
 expect(parseCsv(csv)[0]?.error).toBe('comma, and "quote"');
 expect(usageStats(csv).get('model')).toMatchObject({requests:2,cacheHitRate:0.8,tokensPerSecond:100,ttftMs:500});
});
test('facts use tightest quota, never leak account emails, zero free prices and keep missing facts unknown',()=>{
 const quota=quotaAccounts([{provider:'p',name:'private@example.com',windows:[{remaining:85},{remaining:7}]},{provider:'p',windows:[{remaining:NaN}]}]);
 expect(JSON.stringify(quota.get('p'))).not.toContain('@');expect(quota.get('p')![0]?.remainingPct).toBe(7);
 const facts=modelFacts(['p/gpt-6.1-sol','unknown/x'],{catalog:[{id:'p/gpt-6.1-sol',magpie_label:'免费'}],quota,usage:new Map(),performance:new Map()});
 expect(facts[0]?.price).toEqual({free:true,input:0,output:0,cacheHit:0});expect(facts[1]).toMatchObject({accounts:[],price:{free:false}});expect(facts[1]?.aa).toBeUndefined();
});
test('Jev receives complete facts once per group, rejects partial/low-confidence answers',async()=>{
 let calls=0;const facts=[fact('p/a'),fact('p/b')];
 const jev={model:'fixture',ask:async(state:any,q:any)=>{calls++;expect(state.ownerRules).toBe('速度优先');expect(state.models.m0.id).toBe('p/a');return response(q);}};
 expect(await jevOrder(jev,'sonnet','速度优先',facts)).toEqual(['p/b','p/a']);expect(calls).toBe(1);
 await expect(jevOrder({model:'fixture',ask:async()=>({model:'fixture',answers:{}})},'opus','',facts)).rejects.toThrow();
 await expect(jevOrder({model:'fixture',ask:async()=>({model:'fixture',answers:{m0:{type:'score',score:3,confidence:0.1}}})},'opus','',[fact('p/a')])).rejects.toThrow();
});
function fixture(){
 let settings={ranking_rules:'便宜优先',ranking_refresh_minutes:5};const writes:any[]=[];const calls:string[]=[];let factsCalls=0;
 const db={query:async(sql:string,vars?:any)=>{
  if(sql.startsWith('SELECT ranking_rules'))return [settings];
  if(sql.includes('UPSERT company_meta:model_routing MERGE'))settings={ranking_rules:vars.rules,ranking_refresh_minutes:vars.minutes};
  else writes.push(vars);
  return [undefined];
 }};
 const groups={'sck-fable':['p/owner'],'sck-opus':['p/a','p/b'],'sck-sonnet':['p/a'],'sck-haiku':['p/b']};
 const jev={model:'fixture',ask:async(state:any,q:any)=>{calls.push(state.group);return response(q);}};
 const applied:any[]=[];
 const deps={db:db as any,jev,groups:()=>groups,facts:async(ids:string[])=>{factsCalls++;return ids.map(fact);},apply:async(x:any)=>{applied.push(x);}};
 return {db,deps,writes,calls,applied,factsCalls:()=>factsCalls};
}
test('request refresh is asynchronous, single-flight, interval-controlled and excludes Fable',async()=>{
 const f=fixture();const r=new RankingRefresher(f.deps);
 r.trigger(0);r.trigger(0);expect(f.calls).toEqual([]);await r.settled();
 expect(f.calls).toEqual(['group/sck-opus','group/sck-sonnet','group/sck-haiku']);expect(f.factsCalls()).toBe(1);expect(f.applied).toHaveLength(1);
 r.trigger(299999);await r.settled();expect(f.applied).toHaveLength(1);
 r.trigger(300000);await r.settled();expect(f.applied).toHaveLength(2);
 await saveRankingSettings(f.db as any,{rules:'质量优先',refreshMinutes:2},r);
 expect(await rankingSettings(f.db as any)).toEqual({rules:'质量优先',refreshMinutes:2});
 r.trigger(300001);await r.settled();expect(f.applied).toHaveLength(3);
 r.trigger(420000);await r.settled();expect(f.applied).toHaveLength(3);
 r.trigger(420001);await r.settled();expect(f.applied).toHaveLength(4);
});
test('saving during a refresh invalidates old rules, stopped refresher cannot publish',async()=>{
 const f=fixture();let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);
 f.deps.facts=async(ids:string[])=>{await wait;return ids.map(fact);};
 const r=new RankingRefresher(f.deps);r.trigger();await Promise.resolve();
 await saveRankingSettings(f.db as any,{rules:'新规则',refreshMinutes:10},r);release();await r.settled();expect(f.applied).toHaveLength(0);
 r.trigger();await r.settled();expect(f.applied).toHaveLength(1);
 r.stop();r.reset();r.trigger();await r.settled();expect(f.applied).toHaveLength(1);
 await expect(saveRankingSettings(f.db as any,{rules:'',refreshMinutes:3},r)).rejects.toThrow();
});
test('Jev failure retains group order and records a safe error, retry waits for interval',async()=>{
 const f=fixture();f.deps.jev.ask=async()=>{throw Error('private upstream error');};
 const r=new RankingRefresher(f.deps);r.trigger(0);await r.settled();expect(f.applied).toHaveLength(0);expect(f.writes[0].error).not.toContain('private');
});
test('controller applies persisted group-local orders but preserves manual membership and Fable ordering',async()=>{
 const home=scratch();const store:Record<string,string[]>={};let orders:Record<string,string[]>={};
 const db={query:async(sql:string)=>sql.includes('SELECT enabled')?[{enabled:true}]:sql.includes('SELECT orders')?[{orders}]:[[]]};
 const io={fetch:(async()=>Response.json({data:[{id:'p/gpt-6.1-sol'},{id:'p/deepseek-v4.1-flash'},{id:'p/kimi-k3'}]})) as unknown as typeof fetch,groups:()=>store,command:async(args:string[])=>{if(args[1]==='add')store[args[2]!]=args[3]!.slice(7).split(',');}};
 const c=new ModelRoutingController(db as any,home,'unused',io);await c.refresh(true);
 store['sck-fable']=['p/manual','p/gpt-6.1-sol'];store['sck-sonnet']=['p/manual','p/kimi-k3'];store['sck-haiku']=[];
 orders={'sck-sonnet':['p/kimi-k3','p/deepseek-v4.1-flash','p/manual'],'sck-fable':['p/gpt-6.1-sol','p/manual']};
 await c.applyOrders(orders);
 expect(store['sck-sonnet']).toEqual(['p/kimi-k3','p/manual']);expect(store['sck-fable']).toEqual(['p/manual','p/gpt-6.1-sol']);expect(store['sck-haiku']).toEqual([]);
});
test('blocked background facts never delay the model HTTP request',async()=>{
 const f=fixture();let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);
 f.deps.facts=async(ids:string[])=>{await wait;return ids.map(fact);};const refresher=new RankingRefresher(f.deps);
 const gateway=await startModelGateway({onRequest:()=>refresher.trigger(),lease:async()=>({employee:'e',task:'',fence:0,role:'engineering',tier:'haiku',phase:'idle'}),record:async()=>{},complete:async()=>{},fetchImpl:(async()=>Response.json({input_tokens:1})) as unknown as typeof fetch},0);
 try{const r=await fetch(`http://127.0.0.1:${gateway.port}/a/e/v1/messages/count_tokens`,{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});expect(r.status).toBe(200);expect(f.applied).toHaveLength(0);}
 finally{release();await refresher.settled();await gateway.stop();}
});

test('save/stop while apply is waiting prevents stale publication at the write boundary',async()=>{
 for(const action of ['save','stop']){
  const f=fixture();let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  const published:unknown[]=[];
  const r=new RankingRefresher({...f.deps,apply:async(orders,isCurrent)=>{entered();await wait;if(isCurrent())published.push(orders);}});
  r.trigger();await started;
  if(action==='save')await saveRankingSettings(f.db as any,{rules:'new rules',refreshMinutes:5},r);else r.stop();
  release();await r.settled();expect(published).toHaveLength(0);
 }
});
test('controller rechecks invalidation after waiting for an existing sync',async()=>{
 const home=scratch();let release!:()=>void,entered!:()=>void;
 const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const calls:string[][]=[];let valid=true;
 const db={query:async(sql:string)=>{if(sql.includes('SELECT enabled')){entered();await wait;return [{enabled:true}];}return [[]];}};
 const controller=new ModelRoutingController(db as any,home,'unused',{fetch:(async()=>Response.json({data:[{id:'p/gpt-6.1-sol'},{id:'p/deepseek-v4.1-flash'}]})) as unknown as typeof fetch,command:async args=>{calls.push(args);}});
 const syncing=controller.refresh(true);await started;const applying=controller.applyOrders({'sck-opus':['old/model']},()=>valid);
 valid=false;release();await syncing;const before=calls.length;await applying;expect(calls.length).toBe(before);
});
