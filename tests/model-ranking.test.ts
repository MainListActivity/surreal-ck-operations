import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bundled from '../src/model-routing/benchmarks.json';
import {useBenchmarks,aaRankOf,classify} from '../src/model-routing/policy.ts';
import {parseAaLeaderboard,refreshAa,loadAa} from '../src/model-routing/aa.ts';
import {usageStats,quotaAccounts,modelFacts,jevOrder,RankingRefresher,saveRankingSettings,rankingSettings,DEFAULT_RANKING_RULES,rankingTables,type ModelFacts} from '../src/model-routing/ranking.ts';
import {ModelRoutingController} from '../src/model-routing/controller.ts';
import {startModelGateway} from '../src/model-routing/gateway.ts';
const dirs:string[]=[];
const scratch=()=>{const p=mkdtempSync(join(tmpdir(),'sck-ranking-'));dirs.push(p);return p;};
afterEach(()=>{useBenchmarks(bundled.models);for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const flight=(rows:unknown[])=>`<script>self.__next_f.push(${JSON.stringify([1,`data:{"initialModels":${JSON.stringify(rows)},"x":1}`])})</script>`;
const fact=(id:string):ModelFacts=>({id,accounts:[],price:{free:false}});
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
const nativeUsage=(models:unknown[])=>({period:'7d',since:'2026-10-18T00:00:00Z',models});
const channel=(provider:string,model:string,decode_out:number,decode_ms:number)=>({provider,model,calls:10,errors:1,input:10,cache_read:80,cache_write:10,timed:8,ttft_ms:4000,decode_n:6,decode_out,decode_ms,output:999999,reasoning:888888});
test('native Magpie usage keeps complete provider/model identity and uses Magpie decode totals',()=>{
 const usage=usageStats(nativeUsage([
  channel('remote-magpie','codearts/deepseek-v4.1-flash',100,1000),
  channel('remote-magpie','workbuddy/deepseek-v4.1-flash',100,4000),
  channel('remote-magpie','group/auto-deepseek-v4-1-flash',9999,1000),
 ]),'2026-10-24T03:10:00Z');
 expect(usage.get('remote-magpie/codearts/deepseek-v4.1-flash')).toMatchObject({requests:10,errors:1,cacheHitRate:0.8,tokensPerSecond:100,ttftMs:500,speedSamples:6,ttftSamples:8,source:'magpie',period:'7d',collectedAt:'2026-10-24T03:10:00Z',scope:'provider-model'});
 expect(usage.get('remote-magpie/workbuddy/deepseek-v4.1-flash')?.tokensPerSecond).toBe(25);
 const facts=modelFacts(['remote-magpie/codearts/deepseek-v4.1-flash:max','remote-magpie/workbuddy/deepseek-v4.1-flash:max','remote-magpie/sn/deepseek-v4.1-flash:max'],{catalog:[],quota:new Map(),usage,performance:new Map()});
 expect(facts.map(f=>f.usage?.tokensPerSecond)).toEqual([100,25,undefined]);
});
test('native usage combines same-channel shards with weighted totals, omits unmeasured speed, never serializes account labels',()=>{
 const rows=[{...channel('p','m',100,1000),id:'p/m @ private@example.com',host:'private@example.com'},channel('p','m',100,4000),{...channel('p','unknown',0,0),decode_n:0,timed:0}];
 const stats=usageStats(nativeUsage(rows));
 expect(stats.get('p/m')).toMatchObject({tokensPerSecond:40,requests:20,speedSamples:12,ttftMs:500});
 expect(stats.get('p/unknown')?.tokensPerSecond).toBeUndefined();
 expect(stats.get('p/unknown')?.ttftMs).toBeUndefined();
 expect(JSON.stringify([...stats])).not.toContain('@');
 expect(()=>usageStats({models:[]})).toThrow();
});
test('every rankingFacts collection fetches live native Magpie statistics and fails closed on an unavailable API',async()=>{
 let calls=0;let down=false;
 const db={query:async()=>[[]]};
 const controller=new ModelRoutingController(db as any,scratch(),'unused',{
  output:async(args:string[])=>{expect(args).toEqual(['quota','--json']);return '[]';},
  fetch:(async(url:any,options:any)=>{
   expect(String(url)).toBe('http://127.0.0.1:3425/v1/magpie/usage?period=7d');expect(options.cache).toBe('no-store');calls++;
   return down?new Response('unavailable',{status:503}):Response.json(nativeUsage([channel('p','m',100*calls,1000)]));
  }) as typeof fetch,
 });
 expect((await controller.rankingFacts(['p/m']))[0]?.usage?.tokensPerSecond).toBe(100);
 expect((await controller.rankingFacts(['p/m']))[0]?.usage?.tokensPerSecond).toBe(200);
 down=true;await expect(controller.rankingFacts(['p/m'])).rejects.toThrow();expect(calls).toBe(3);
});
test('facts use tightest quota, never leak account emails, zero free prices and keep missing facts unknown',()=>{
 const quota=quotaAccounts([{provider:'p',name:'private@example.com',windows:[{remaining:85},{remaining:7}]},{provider:'p',windows:[{remaining:NaN}]}]);
 expect(JSON.stringify(quota.get('p'))).not.toContain('@');expect(quota.get('p')![0]?.remainingPct).toBe(7);
 const facts=modelFacts(['p/gpt-6.1-sol','unknown/x'],{catalog:[{id:'p/gpt-6.1-sol',magpie_label:'免费'}],quota,usage:new Map(),performance:new Map()});
 expect(facts[0]?.price).toEqual({free:true,input:0,output:0,cacheHit:0});expect(facts[1]).toMatchObject({accounts:[],price:{free:false}});expect(facts[1]?.aa).toBeUndefined();
});
test('Jev receives complete facts once per group, rejects partial answers but orders low-confidence mid scores',async()=>{
 let calls=0;const facts=[fact('p/a'),fact('p/b')];
 const jev={model:'fixture',ask:async(state:any,q:any)=>{calls++;expect(state.ownerRules).toBe('速度优先');expect(state.models.m0.id).toBe('p/a');return response(q);}};
 expect(await jevOrder(jev,'sonnet','速度优先',facts)).toEqual(['p/b','p/a']);expect(calls).toBe(1);
 await expect(jevOrder({model:'fixture',ask:async()=>({model:'fixture',answers:{}})},'opus','',facts)).rejects.toThrow();
 await expect(jevOrder({model:'fixture',ask:async()=>({model:'fixture',answers:{m0:{type:'score',score:3}}})},'opus','',facts)).rejects.toThrow();
 // Production shape: a middling model's confidence is the mass on its modal level and can be ~0.2.
 expect(await jevOrder({model:'fixture',ask:async()=>({model:'fixture',answers:{m0:{type:'score',score:2.15,confidence:0.16},m1:{type:'score',score:3.6,confidence:0.67}}})},'opus','',facts)).toEqual(['p/b','p/a']);
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
test('request refresh is asynchronous, single-flight, interval-controlled and excludes Fable and Opus',async()=>{
 const f=fixture();const r=new RankingRefresher(f.deps);
 r.trigger(0);r.trigger(0);expect(f.calls).toEqual([]);await r.settled();
 expect(f.calls).toEqual(['group/sck-sonnet','group/sck-haiku']);expect(f.factsCalls()).toBe(1);expect(f.applied).toHaveLength(1);
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
 const r=new RankingRefresher(f.deps);r.trigger(0);await r.settled();expect(f.applied).toHaveLength(0);expect(f.writes.find(w=>w?.error)?.error).not.toContain('private');
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

test('empty and whitespace rules use the default in settings, saved values and the actual request',async()=>{
 const f=fixture();const r=new RankingRefresher(f.deps);
 for(const rules of ['', '   ']) {
  await saveRankingSettings(f.db as any,{rules,refreshMinutes:5},r);
  expect((await rankingSettings(f.db as any)).rules).toBe(DEFAULT_RANKING_RULES);
  await jevOrder({model:'fixture',ask:async(state:any,q:any)=>{
   expect(state.ownerRules).toBe('智能程度和速度综合优先');return response(q);
  }},'haiku',rules,[fact('p/a')]);
 }
});
test('request snapshot exactly matches the serialized body and is available before a failed Jev attempt',async()=>{
 let snapshot:any;
 const facts=[{...fact('p/a'),usage:undefined}];
 await expect(jevOrder({model:'fixture',ask:async(state,questions)=>{
  expect(snapshot).toEqual(JSON.parse(JSON.stringify({model:'fixture',state,questions})));
  expect(Object.hasOwn((snapshot.state.models as any).m0,'usage')).toBe(false);
  throw Error('upstream unavailable');
 }},'opus','速度优先',facts,async payload=>{snapshot=structuredClone(payload);})).rejects.toThrow('upstream unavailable');
 expect(snapshot.state.ownerRules).toBe('速度优先');
 expect(snapshot.questions.m0.instructions).toContain('state.ownerRules');
 expect(snapshot.questions.m0.criteria[0]).toContain('排最后');
});

test('unavailable live usage cancels the refresh before any Jev call or ranking publication',async()=>{
 const f=fixture();let reads=0;
 const controller=new ModelRoutingController({query:async()=>[[]]} as any,scratch(),'unused',{
  output:async()=> '[]', fetch:(async()=>{reads++;return new Response('unavailable',{status:503});}) as unknown as typeof fetch,
 });
 f.deps.facts=async(ids:string[])=>controller.rankingFacts(ids);
 const r=new RankingRefresher(f.deps);r.trigger();await r.settled();
 expect(reads).toBe(1);expect(f.calls).toEqual([]);expect(f.applied).toEqual([]);
});

test('successful Jev snapshots retain exact decimal scores, raw answers, facts, and stable ties',async()=>{
 const facts=[{...fact('p/a'),aa:{score:45.1,rank:30},usage:{...usageStats(nativeUsage([channel('p','a',164,1000)])).get('p/a')!}},fact('p/b'),fact('p/c')];
 let snapshot:any;
 const answers={m0:{type:'score' as const,score:3.712345,confidence:0.8},m1:{type:'score' as const,score:3.712345,confidence:0.4},m2:{type:'score' as const,score:0,confidence:1}};
 expect(await jevOrder({model:'configured',ask:async()=>({model:'served-jev',answers})},'haiku','速度优先',facts,undefined,result=>{snapshot=result;})).toEqual(['p/a','p/b','p/c']);
 expect(snapshot).toMatchObject({tier:'haiku',model:'served-jev',rules:'速度优先',answers});
 expect(snapshot.rows.map((row:any)=>row.score)).toEqual([3.712345,3.712345,0]);
 facts[0]!.aa!.score=99;expect(snapshot.rows[0].facts.aa.score).toBe(45.1);
 let published=false;
 await expect(jevOrder({model:'broken',ask:async()=>({model:'broken',answers:{m0:{type:'score',score:5}}})},'haiku','',[fact('p/a')],undefined,()=>{published=true;})).rejects.toThrow();
 expect(published).toBe(false);
});

test('refresh persists successful snapshots with orders, excludes failed groups and invalidated results',async()=>{
 const f=fixture();
 f.deps.jev.ask=async(state:any,q:any)=>{if(state.group==='group/sck-sonnet')throw Error('down');return response(q);};
 const r=new RankingRefresher(f.deps);r.trigger();await r.settled();
 const publication=f.writes.find(w=>w?.results);
 expect(Object.keys(publication.results)).toEqual(['sck-haiku']);
 expect(publication.orders['sck-haiku']).toEqual(publication.results['sck-haiku'].rows.map((row:any)=>row.facts.id));
 expect(publication.results['sck-haiku'].rows[0].score).toBe(0);
});

test('ranking list joins current members to one successful snapshot, never a newer failed attempt or another effort',async()=>{
 const {rankingTables}=await import('../src/model-routing/ranking.ts');
 let snapshot:any;
 await jevOrder({model:'jev',ask:async()=>({model:'jev',answers:{m0:{type:'score',score:3.25},m1:{type:'score',score:0}}})},'haiku','旧规则',[
  {...fact('p/a:max'),usage:usageStats(nativeUsage([channel('p','a',100,1000)])).get('p/a'),accounts:[{account:'p #1',remainingPct:0}],aa:{rank:30,score:45.1},performance:{score:4.72,samples:2.5}},fact('p/b'),
 ],undefined,r=>{snapshot=r;});
 const requests:any=[{tier:'haiku',at:'new-at',payload:{state:{ownerRules:'新规则',models:{m0:{...fact('p/a:max'),aa:{rank:1,score:99}},m1:fact('p/a:high')}}}}];
 const groups={'sck-haiku':['p/b','p/a:max','p/a:high','p/new']};
 const table=rankingTables(groups,{'sck-haiku':snapshot},requests)[0]!;
 expect(table.rules).toBe('旧规则');expect(table.rows.map(r=>r.model)).toEqual(groups['sck-haiku']);
 expect(table.rows[0]?.jevScore).toBe(0);expect(table.rows[1]).toMatchObject({jevScore:3.25,aaScore:45.1,accounts:[{account:'p #1',remainingPct:0}],performanceSamples:2.5,stabilityPct:90,stabilitySamples:10});
 expect(table.rows[2]?.jevScore).toBeUndefined();expect(table.rows[2]?.aaScore).toBeUndefined();
 const legacy=rankingTables(groups,{},requests)[0]!;expect(legacy.scored).toBe(false);expect(legacy.at).toBe('new-at');expect(legacy.rows[1]?.aaScore).toBe(99);expect(legacy.rows.every(r=>r.jevScore===undefined)).toBe(true);
});

test('pins exclude exact effort IDs from Jev, persist immediately, and serialize across owner surfaces',async()=>{
 let pins:Record<string,string[]>={};let stored:Record<string,string[]>={};let fail=false;
 const members:Record<string,string[]>={'sck-haiku':['p/a:max','p/b:max','p/a:high']};
 const sent:any[]=[];const published:any[]=[];
 const db={query:async(sql:string,v?:any)=>{
  if(sql.startsWith('SELECT pins'))return [{pins}];
  if(sql.startsWith('SELECT ranking_rules'))return [{}];
  if(sql.includes('SET pins=')){pins={...pins,...v.pins};stored={...stored,...v.orders};}
  return [undefined];
 }};
 const deps={db:db as any,groups:()=>members,facts:async(ids:string[])=>ids.map(fact),apply:async(orders:Record<string,string[]>,current:()=>boolean)=>{if(current()){published.push(orders);Object.assign(members,orders);}},jev:{model:'fixture',ask:async(state:any,q:any)=>{sent.push(state);if(fail)throw Error('upstream');return response(q);}}};
 const r=new RankingRefresher(deps);
 await Promise.all([r.setPin('sck-haiku','p/b:max',true),r.setPin('sck-haiku','p/a:max',true)]);
 expect(pins).toEqual({'sck-haiku':['p/b:max','p/a:max']});expect(stored['sck-haiku']).toEqual(['p/b:max','p/a:max','p/a:high']);expect(sent).toHaveLength(0);
 await r.setPin('sck-haiku','p/b:max',true);expect(pins['sck-haiku']).toEqual(['p/b:max','p/a:max']);
 r.trigger(1);await r.settled();expect(Object.values(sent[0].models).map((f:any)=>f.id)).toEqual(['p/a:high']);expect(members['sck-haiku']).toEqual(['p/b:max','p/a:max','p/a:high']);
 await r.setPin('sck-haiku','p/a:high',true);const before=sent.length;
 const restarted=new RankingRefresher(deps);restarted.trigger(2);await restarted.settled();expect(sent).toHaveLength(before);expect(members['sck-haiku']).toEqual(['p/b:max','p/a:max','p/a:high']);
 await restarted.setPin('sck-haiku','p/b:max',false);restarted.trigger(3);await restarted.settled();expect(Object.values(sent.at(-1).models).map((f:any)=>f.id)).toEqual(['p/b:max']);expect(members['sck-haiku']).toEqual(['p/a:max','p/a:high','p/b:max']);
 fail=true;await restarted.setPin('sck-haiku','p/a:high',false);restarted.trigger(4);await restarted.settled();expect(members['sck-haiku'][0]).toBe('p/a:max');
 await expect(r.setPin('sck-fable','p/a:max',true)).rejects.toThrow();await expect(r.setPin('sck-haiku','p/missing',true)).rejects.toThrow();
});

test('pin invalidates an in-flight Jev result before publishing the manual order',async()=>{
 const f=fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const r=new RankingRefresher({...f.deps,jev:{model:'fixture',ask:async(_s:any,q:any)=>{entered();await wait;return response(q);}}});
 r.trigger();await started;const pin=r.setPin('sck-sonnet','p/a',true);release();await pin;
 expect(f.applied).toEqual([{'sck-sonnet':['p/a']}]);
});

test('controller refresh enforces persisted pins ahead of cached Jev orders without adding absent members',async()=>{
 const home=scratch(),store:Record<string,string[]>={};let pins:Record<string,string[]>={};
 const db={query:async(sql:string)=>sql.includes('SELECT enabled')?[{enabled:true}]:sql.includes('SELECT orders')?[{orders:{'sck-haiku':['p/b','p/a']},pins}]:[[]]};
 const io={fetch:(async()=>Response.json({data:[{id:'p/gpt-6.1-sol'},{id:'p/deepseek-v4.1-flash'},{id:'p/kimi-k3'}]})) as unknown as typeof fetch,groups:()=>store,command:async(args:string[])=>{if(args[1]==='add')store[args[2]!]=args[3]!.slice(7).split(',');}};
 const c=new ModelRoutingController(db as any,home,'unused',io);await c.refresh(true);
 store['sck-haiku']=['p/b','p/a'];pins={'sck-haiku':['p/missing','p/a']};await c.refresh(true);expect(store['sck-haiku']).toEqual(['p/a','p/b']);
 const restarted=new ModelRoutingController(db as any,home,'unused',io);await restarted.refresh(true);expect(store['sck-haiku']).toEqual(['p/a','p/b']);
});

test('pinned rows keep observed metrics outside Jev scores and never borrow another effort',()=>{
 const result={tier:'haiku' as const,at:'2026-10-24T12:00:00Z',model:'fixture',rules:'speed',rows:[{facts:fact('p/b'),score:3}],answers:{},pinnedFacts:[{...fact('p/a:max'),aa:{rank:2,score:45},usage:{source:'magpie' as const,period:'7d' as const,collectedAt:'now',scope:'provider-model' as const,requests:10,errors:0,speedSamples:10,ttftSamples:10,tokensPerSecond:100}}]};
 const rows=rankingTables({'sck-haiku':['p/a:max','p/a:high','p/b']},{'sck-haiku':result},[],{'sck-haiku':['p/a:max']})[0]!.rows;
 expect(rows[0]).toMatchObject({pinned:true,aaScore:45,tokensPerSecond:100});expect(rows[0]!.jevScore).toBeUndefined();expect(rows[1]!.aaScore).toBeUndefined();expect(rows[2]!.jevScore).toBe(3);
});

test('owner rules are explicit in each independent question and concrete priority criteria',async()=>{
 const rules='智能程度和速度综合优先，首token延迟超过10s的排在最后';
 await jevOrder({model:'fixture',ask:async(state:any,questions:any)=>{
  expect(state.ownerRules).toBe(rules);
  for(const [key,q] of Object.entries(questions) as any){
   expect(q.instructions).toContain('state.ownerRules');
   expect(q.instructions).toContain('命中时必须选0级');
   expect(q.instructions).toContain(`state.models.${key}`);
   expect(state.rankingPolicy.instructions).toContain('不能抵消');
   expect(q.criteria[0]).toContain('排最后');
   for(const level of q.criteria.slice(1))expect(level).toContain('未触发');
   expect(state.rankingPolicy.levels).toHaveLength(5);
  }
  return response(questions);
 }},'haiku',rules,[fact('p/slow'),fact('p/fast')]);
});

test('automatic ranking neither reads facts nor sends Jev questions or applies orders for manual Opus',async()=>{
 const f=fixture();const requested:string[][]=[];
 f.deps.groups=()=>({'sck-opus':['owner/manual:high'],'sck-sonnet':['p/a'],'sck-haiku':['p/b'],'sck-fable':['owner/z']});
 f.deps.facts=async ids=>{requested.push(ids);return ids.map(fact);};
 const r=new RankingRefresher(f.deps);r.trigger();await r.settled();
 expect(requested).toEqual([['p/a','p/b']]);
 expect(f.calls).toEqual(['group/sck-sonnet','group/sck-haiku']);
 expect(f.applied[0]['sck-opus']).toBeUndefined();
 await expect(r.setPin('sck-opus','owner/manual:high',true)).rejects.toThrow();
 expect(rankingTables({'sck-opus':['owner/manual:high']},{},[],{'sck-opus':['owner/manual:high']})).toEqual([]);
});

test('Jev failure preserves successful scores while independent safety observations demote and recover members',async()=>{
 let results:Record<string,any>={},gates:Record<string,any>={};let fail=false,bad=false;
 let members=['p/a','p/b'];
 const db={query:async(sql:string,v?:any)=>{
  if(sql.startsWith('SELECT pins'))return [{}];if(sql.startsWith('SELECT ranking_rules'))return [{}];
  if(v?.results){Object.assign(results,v.results);Object.assign(gates,v.gates);}
  return [undefined];
 }};
 const r=new RankingRefresher({db:db as any,groups:()=>({'sck-haiku':members}),facts:async()=>members.map(id=>({...fact(id),...(id==='p/a'&&bad?{health:{source:'magpie-routing' as const,excluded:true,reason:'unavailable' as const,attempts:1,errors:1,consecutiveErrors:1,lastStatus:403}}:{})})),
  apply:async o=>{members=o['sck-haiku']!;},jev:{model:'fixture',ask:async(_s,q)=>{if(fail)throw Error('upstream');return response(q);}}});
 r.trigger(0);await r.settled();const success=structuredClone(results['sck-haiku']);
 fail=true;bad=true;r.trigger(300000);await r.settled();
 expect(results['sck-haiku']).toEqual(success);expect(members.at(-1)).toBe('p/a');
 let t=rankingTables({'sck-haiku':members},results,[],{},gates)[0]!;
 expect(t.scored).toBe(true);expect(t.at).toBe(success.at);expect(t.rows.find(r=>r.model==='p/b')?.jevScore).toBe(1);
 expect(t.rows.find(r=>r.model==='p/a')?.jevScore).toBeUndefined();expect(t.rows.find(r=>r.model==='p/a')?.health?.excluded).toBe(true);
 bad=false;r.trigger(600000);await r.settled();
 t=rankingTables({'sck-haiku':members},results,[],{},gates)[0]!;
 expect(t.rows.find(r=>r.model==='p/a')?.health?.excluded).not.toBe(true);expect(t.rows.find(r=>r.model==='p/a')?.jevScore).toBe(0);
});


test('compact questions keep the actual average latency directly readable without repeating owner rules',async()=>{
 const rules='智能程度和速度综合优先，首token延迟超过10s的排在最后';
 const slow={...fact('p/slow'),usage:usageStats(nativeUsage([{...channel('p','slow',1000,12000),ttft_ms:96000}])).get('p/slow')!};
 await jevOrder({model:'fixture',ask:async(s:any,q:any)=>{expect(s.ownerRules).toBe(rules);expect(q.m0.instructions).toContain('12秒');expect(q.m0.instructions).toContain('命中时必须选0级');expect(q.m0.instructions).not.toContain(rules);return response(q);}},'haiku',rules,[slow]);
});
