import {expect,test} from 'bun:test';
import {ruleOrder,recentMetric,accountFacts,TTFT_LIMIT_MS} from '../src/model-routing/rules.ts';
import {quotaAccounts,rankingTables,RankingRefresher,type ModelFacts} from '../src/model-routing/ranking.ts';
const now=Date.parse('2026-10-27T12:00:00Z');
const fact=(id:string,score?:number,ttft?:number):ModelFacts=>({id,accounts:[{account:'anonymous',kind:'subscription',remainingPct:80}],price:{free:false},...(score===undefined?{}:{aa:{score,rank:1}}),...(ttft===undefined?{}:{usage:{source:'magpie',period:'7d',scope:'provider-model',collectedAt:new Date(now).toISOString(),requests:10,errors:0,ttftSamples:10,speedSamples:0,ttftMs:ttft}})});
const order=(f:ModelFacts[],pins:string[]=[])=>ruleOrder(f,pins,now).map(r=>r.facts.id);
test('the exact 20 second boundary remains eligible; greater latency cannot buy priority with AA or a pin',()=>{
 expect(TTFT_LIMIT_MS).toBe(20000);
 const f=[fact('slow',99,20001),fact('boundary',50,20000),fact('fast',49,500)];
 expect(order(f,['slow'])).toEqual(['fast','boundary','slow']);
 expect(ruleOrder(f,['slow'],now).at(-1)?.decision.tail).toBe('首 token 超过20秒');
});
test('equally capable and within 20 seconds: TTFT wins even against a slightly higher AA score or much faster decode',()=>{
 const a=fact('AA60',60,18000),b=fact('AA59',59,700);a.usage!.tokensPerSecond=500;a.usage!.speedSamples=10;b.usage!.tokensPerSecond=10;b.usage!.speedSamples=10;
 expect(order([a,b])).toEqual(['AA59','AA60']);
 expect(order([fact('strong',60,18000),fact('weak',55,700)])).toEqual(['strong','weak']);
});
test('AA bands are anchored partitions, not a non-transitive pairwise tolerance',()=>{
 const facts=[fact('a',60,4000),fact('b',58,3000),fact('c',56,1000)];
 for(const list of [facts,[...facts].reverse(),[facts[1]!,facts[2]!,facts[0]!]])expect(order(list)).toEqual(['b','a','c']);
 expect(ruleOrder(facts,[],now).map(r=>[r.facts.id,r.decision.band])).toEqual([['b',0],['a',0],['c',1]]);
});
test('native subscription identity takes priority over metered models; zero price is not subscription evidence',()=>{
 const sub=fact('sub',50,1000),api=fact('api',70,100),unknown=fact('unknown',90,50);
 api.accounts=[{account:'api',kind:'api',remainingPct:100}];api.price={free:true};unknown.accounts=[];
 expect(order([api,unknown,sub])).toEqual(['sub','unknown','api']);
 expect(accountFacts(unknown,now)).toMatchObject({billing:'unknown',quota:'unknown'});
});
test('a model with any unmeasured account is not reported as definitively exhausted; best available account wins',()=>{
 const f=fact('multiple',50,100);f.accounts=[{account:'empty',kind:'subscription',remainingPct:0},{account:'unknown',kind:'subscription'}];
 expect(accountFacts(f,now).quota).toBe('unknown');f.accounts[1]!.remainingPct=60;
 expect(accountFacts(f,now)).toMatchObject({quota:'available',remainingPct:60});
});
test('latest sufficient EWMA supersedes a huge historical average; stale trends cannot pretend to be current',()=>{
 const f=fact('trend',60,4000);
 f.trends={ttftMs:{unit:'ms',sampleUnit:'request',ewma:25000,current:30000,samples:10,sufficient:true,lastSampleAt:new Date(now-1000).toISOString(),change:{detected:true,direction:'up'},baseline:{samples:100000,mean:4000},windows:{}}};
 expect(recentMetric(f,'ttftMs',now)).toEqual({value:25000,source:'recent-ewma'});expect(ruleOrder([f],[],now)[0]!.decision.tail).toContain('20秒');
 f.trends.ttftMs!.lastSampleAt=new Date(now-3600000).toISOString();expect(recentMetric(f,'ttftMs',now)).toEqual({value:4000,source:'historical-average'});
});
test('unknown TTFT is never encoded as zero and loses to measured latency within the same capability band',()=>{
 const rows=ruleOrder([fact('unknown',60),fact('measured',60,19000)],[],now);
 expect(rows.map(r=>r.facts.id)).toEqual(['measured','unknown']);expect(rows[1]!.decision).toMatchObject({latencySource:'unknown'});expect(rows[1]!.decision.ttftMs).toBeUndefined();
});
test('error gates and exhausted budgets cannot be overridden by pinning',()=>{
 const bad=fact('bad',99,50);bad.health={source:'magpie-routing',excluded:true,attempts:3,errors:3,consecutiveErrors:3};const spent=fact('spent',99,50);spent.accounts[0]!.remainingPct=0;
 expect(order([bad,spent,fact('healthy',50,100)],['bad','spent'])).toEqual(['healthy','spent','bad']);
});
test('quota parsing retains reset windows and billing kinds but anonymizes account labels',()=>{
 const rows=quotaAccounts([{provider:'p',kind:'plan',name:'private@example.com',windows:[{remaining:60,resetsAt:'2026-11-28T12:00:00Z'}]}]);
 expect(JSON.stringify([...rows])).not.toContain('@');const f=fact('p/m',50,100);f.accounts=rows.get('p')!;
 expect(accountFacts(f,now)).toMatchObject({billing:'subscription',remainingPct:60,pace:60/(32*24)});
});
test('same capability/latency/decode: final accepted task performance breaks ties, never a Jev answer',()=>{
 const a=fact('a',50,100),b=fact('b',50,100);a.performance={score:4,samples:2};b.performance={score:5,samples:2};expect(order([a,b])).toEqual(['b','a']);
});
test('rule snapshots expose actual latency and reasons, never a fabricated Jev score',()=>{
 const rows=ruleOrder([fact('p/a',50,21000)],[],now);
 const table=rankingTables({'sck-haiku':['p/a']},{'sck-haiku':{engine:'quality-pace-v1',tier:'haiku',at:new Date(now).toISOString(),model:'quality-pace-v1',rules:'fixed',answers:{},rows:rows.map(r=>({...r,score:0}))}})[0]!;
 expect(table.rows[0]!.decision?.ttftMs).toBe(21000);expect(table.rows[0]!.tailReason).toContain('20秒');expect(table.rows[0]!.jevScore).toBeUndefined();
});

test('first rule publication beats legacy pins, uses native PACE only for involved providers and records original settings',async()=>{
 const {ModelRoutingController}=await import('../src/model-routing/controller.ts');
 const {mkdtempSync,rmSync,readFileSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'sck-native-pace-'));const groups:Record<string,string[]>={'sck-haiku':['p/gpt-6.1-sol','p/kimi-k3'],'sck-opus':['manual/opus'],'sck-fable':['manual/fable']};const commands:string[][]=[];
 const db={query:async(sql:string)=>sql.includes('SELECT enabled')?[{enabled:true}]:sql.includes('SELECT orders')?[{orders:{},pins:{'sck-haiku':['p/gpt-6.1-sol']}}]:[[]]};
 const controller=new ModelRoutingController(db as any,home,'unused',{providerRouting:()=>({p:'smart',manual:'order'}),groups:()=>groups,fetch:(async()=>Response.json({data:[{id:'p/gpt-6.1-sol'},{id:'p/kimi-k3'}]})) as unknown as typeof fetch,command:async a=>{commands.push(a);if(a[0]==='group'&&a[1]==='add')groups[a[2]!]=a[3]!.slice(7).split(',');}});
 try{
  await controller.refresh(true);groups['sck-haiku']=['p/gpt-6.1-sol','p/kimi-k3'];groups['sck-opus']=['manual/opus'];groups['sck-fable']=['manual/fable'];commands.length=0;
  await controller.applyOrders({'sck-haiku':['p/kimi-k3','p/gpt-6.1-sol']});
  expect(groups['sck-haiku']).toEqual(['p/kimi-k3','p/gpt-6.1-sol']);expect(groups['sck-opus']).toEqual(['manual/opus']);expect(groups['sck-fable']).toEqual(['manual/fable']);
  expect(commands.filter(a=>a[0]==='provider')).toEqual([['provider','set','p','routing=pace']]);
  expect(JSON.parse(readFileSync(join(home,'model-routing/account-routing.json'),'utf8'))).toEqual({original:{p:'smart'}});
  const backup=join(home,'model-routing/account-routing.json');writeFileSync(backup,'broken backup');commands.length=0;
  await expect(controller.applyOrders({'sck-haiku':['p/gpt-6.1-sol','p/kimi-k3']})).rejects.toThrow();
  expect(readFileSync(backup,'utf8')).toBe('broken backup');expect(commands.filter(a=>a[0]==='provider')).toEqual([]);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('cancelled two-group publication cannot leak its other group through a later pin or refresh',async()=>{
 const {ModelRoutingController}=await import('../src/model-routing/controller.ts');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'sck-cancelled-ranking-'));const groups:Record<string,string[]>={};let hold=false,valid=true,entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const db={query:async(sql:string)=>sql.includes('SELECT enabled')?[{enabled:true}]:[[]]};
 const c=new ModelRoutingController(db as any,home,'unused',{providerRouting:()=>({}),groups:()=>groups,fetch:(async()=>{if(hold){entered();await wait;}return Response.json({data:[{id:'p/gpt-6.1-sol'},{id:'p/kimi-k3'}]});}) as unknown as typeof fetch,command:async a=>{if(a[0]==='group'&&a[1]==='add')groups[a[2]!]=a[3]!.slice(7).split(',');}});
 try{
  await c.refresh(true);groups['sck-sonnet']=['p/owner-b','p/owner-a'];groups['sck-haiku']=['p/h2','p/h1'];
  await c.applyOrders({'sck-sonnet':['p/owner-b','p/owner-a']});
  hold=true;const stale=c.applyOrders({'sck-sonnet':['p/owner-a','p/owner-b'],'sck-haiku':['p/h1','p/h2']},()=>valid);await started;valid=false;release();await stale;
  hold=false;await c.applyOrders({'sck-haiku':['p/h2','p/h1']});expect(groups['sck-sonnet']).toEqual(['p/owner-b','p/owner-a']);
 }finally{rmSync(home,{recursive:true,force:true});}
});
