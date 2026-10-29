import {expect,test} from 'bun:test';
import {ruleOrder,recentMetric,accountFacts,TTFT_LIMIT_MS} from '../src/model-routing/rules.ts';
import {quotaAccounts,rankingTables,RankingRefresher,type ModelFacts} from '../src/model-routing/ranking.ts';
const now=Date.parse('2026-10-27T12:00:00Z');
const fact=(id:string,score?:number,ttft?:number):ModelFacts=>({id,accounts:[{account:'anonymous',kind:'subscription',remainingPct:80}],price:{free:false},...(score===undefined?{}:{aa:{score,rank:1}}),...(ttft===undefined?{}:{usage:{source:'magpie',period:'7d',scope:'provider-model',collectedAt:new Date(now).toISOString(),requests:10,errors:0,ttftSamples:10,speedSamples:0,ttftMs:ttft}})});
const order=(f:ModelFacts[],pins:string[]=[])=>ruleOrder(f,pins,now).map(r=>r.facts.id);
test('20 seconds is a continuous penalty reference and manual pins are explicit overrides',()=>{
 expect(TTFT_LIMIT_MS).toBe(20000);
 const rows=ruleOrder([fact('below',50,19999),fact('above',50,20001)],[],now);
 expect(rows[0]!.decision.score!-rows[1]!.decision.score!).toBeLessThan(0.01);
 expect(rows.every(r=>!r.decision.tail)).toBe(true);
 expect(order([fact('slow',99,300000),fact('fast',50,30000)],['slow'])).toEqual(['slow','fast']);
});
test('latency interacts with intelligence and decode instead of being an unrelated partition',()=>{
 const a=fact('AA60',60,18000),b=fact('AA59',59,700);a.usage!.tokensPerSecond=500;a.usage!.speedSamples=10;b.usage!.tokensPerSecond=10;b.usage!.speedSamples=10;
 expect(order([a,b])).toEqual(['AA59','AA60']);
 expect(order([fact('strong',60,18000),fact('weak',55,700)])).toEqual(['weak','strong']);
});
test('global score order is invariant to input permutations without AA bands',()=>{
 const facts=[fact('a',60,4000),fact('b',58,3000),fact('c',56,1000)],expected=order(facts);
 for(const list of [[...facts].reverse(),[facts[1]!,facts[2]!,facts[0]!]])expect(order(list)).toEqual(expected);
 expect(ruleOrder(facts,[],now).every(r=>r.decision.band===undefined)).toBe(true);
});
test('billing contributes to utility while account facts retain honest unknown status',()=>{
 const free=fact('free',60,1000),sub=fact('sub',60,1000),unknown=fact('unknown',60,1000);free.price.free=true;unknown.accounts=[];
 const rows=ruleOrder([unknown,sub,free],[],now);
 expect(rows[0]!.facts.id).toBe('free');
 expect(rows.map(r=>r.decision.score)).toEqual(rows.map(r=>r.decision.score!).sort((a,b)=>b-a));
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
 expect(recentMetric(f,'ttftMs',now)).toEqual({value:25000,source:'recent-ewma'});expect(ruleOrder([f],[],now)[0]!.decision.factors!.latency).toBeLessThan(0.5);
 f.trends.ttftMs!.lastSampleAt=new Date(now-3600000).toISOString();expect(recentMetric(f,'ttftMs',now)).toEqual({value:4000,source:'historical-average'});
});
test('unknown TTFT is never encoded as zero and loses to measured latency within the same capability band',()=>{
 const rows=ruleOrder([{...fact('unknown',60),health:{source:'magpie-routing',attempts:10,errors:0,consecutiveErrors:0,excluded:false}},fact('measured',60,19000)],[],now);
 expect(rows.map(r=>r.facts.id)).toEqual(['measured','unknown']);expect(rows[1]!.decision).toMatchObject({latencySource:'unknown'});expect(rows[1]!.decision.ttftMs).toBeUndefined();
});
test('automatic error and quota gates remain; manual pins form the independent first tier',()=>{
 const bad=fact('bad',99,50);bad.health={source:'magpie-routing',excluded:true,attempts:3,errors:3,consecutiveErrors:3};const spent=fact('spent',99,50);spent.accounts[0]!.remainingPct=0;
 expect(order([bad,spent,fact('healthy',50,100)])).toEqual(['healthy','bad','spent']);
 expect(order([bad,spent,fact('healthy',50,100)],['bad','spent'])).toEqual(['bad','spent','healthy']);
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
 const table=rankingTables({'sck-haiku':['p/a']},{'sck-haiku':{engine:'quality-pace-v2',tier:'haiku',at:new Date(now).toISOString(),model:'quality-pace-v1',rules:'fixed',answers:{},rows:rows.map(r=>({...r,score:0}))}})[0]!;
 expect(table.rows[0]!.decision?.ttftMs).toBe(21000);expect(table.rows[0]!.tailReason).toBeUndefined();expect(table.rows[0]!.decision!.factors!.latency).toBeLessThan(0.5);expect(table.rows[0]!.jevScore).toBeUndefined();
});

test('controller preserves published orders, uses native PACE only for involved providers and records original settings',async()=>{
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
