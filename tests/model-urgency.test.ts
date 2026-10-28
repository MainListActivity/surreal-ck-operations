import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assessUrgency,UrgencyTracker} from '../src/model-routing/urgency.ts';
import {modelFacts,quotaAccounts,rankingTables,type ModelFacts} from '../src/model-routing/ranking.ts';
import {readUsageSamples,type LargeRequest} from '../src/model-routing/trends.ts';
import {ruleOrder} from '../src/model-routing/rules.ts';
import {rankingLayers} from '../plugin/shared/ranking-layers.ts';
const now=Date.parse('2026-10-28T02:00:00Z'),iso=(t:number)=>new Date(t).toISOString();
const facts=(id='p/a',amount=100,readAt=now):ModelFacts=>({id,price:{free:false},accounts:[{account:'p #1',poolKey:'pool',kind:'subscription',remainingPct:80,readAt:iso(readAt),windows:[{name:'Credits',remainingPct:80,runsOutAt:iso(now+3600000),runsOut:amount,unit:'credits'}]}]});
const requests=(n:number,model='p/a'):LargeRequest[]=>Array.from({length:n},(_,i)=>({id:String(i),model,at:now+(i+1)*1000}));

test('pins, usable urgent models, ordinary layers, then hard tails; urgency ignores AA/cost/cold divisions',()=>{
 const weak=facts('p/weak');weak.aa={score:20,rank:100};weak.price.free=true;
 const strong=facts('p/strong');strong.aa={score:80,rank:1};strong.accounts[0]!.kind='api';
 const ordinary={...facts('p/ordinary'),accounts:[]};ordinary.aa={score:99,rank:1};
 const bad={...facts('p/bad'),health:{source:'magpie-routing' as const,excluded:true,attempts:4,errors:4,consecutiveErrors:4}};
 const pin={...bad,id:'p/pin'};
 const slow=facts('p/slow');slow.usage={source:'magpie',period:'7d',scope:'provider-model',collectedAt:iso(now),requests:1,errors:0,speedSamples:0,ttftSamples:1,ttftMs:21000};
 const f=assessUrgency([ordinary,weak,strong,bad,pin,slow],[],{},now).facts;
 const rows=ruleOrder(f,['p/pin'],now);
 expect(rows[0]!.facts.id).toBe('p/pin');expect(rows.slice(1,3).every(r=>r.decision.urgent)).toBe(true);
 expect(rows[1]!.decision.score!).toBeGreaterThanOrEqual(rows[2]!.decision.score!);expect(rows[3]!.facts.id).toBe('p/ordinary');
 expect(rows.at(-1)!.decision.tail).toBeTruthy();expect(rows.find(r=>r.facts.id==='p/slow')!.decision.urgent).toBe(false);
 const table=rankingTables({'sck-haiku':rows.map(r=>r.facts.id)},{'sck-haiku':{engine:'quality-pace-v4',tier:'haiku',at:iso(now),model:'rules',rules:'',rows,answers:{}}},[],{'sck-haiku':['p/pin']})[0]!;
 const layers=rankingLayers(table);expect(layers[1]!.title).toContain('第2层 · 临期额度优先');expect(layers[1]!.count).toBe(2);expect(layers[1]!.comparison).toContain('5条');
 const embed=new Function('return ('+rankingLayers.toString()+')')();expect(embed(table)).toEqual(layers);
});

test('five qualifying requests require a new quota read after completion; the same batch stays excluded',()=>{
 const start=assessUrgency([facts()],[],{},now);
 const four=assessUrgency([facts('p/a',100,now+6000)],requests(4),start.state,now+7000);
 expect(four.facts[0]!.urgency).toMatchObject({active:true,requests:4});
 const stale=assessUrgency([facts('p/a',100,now+4500)],requests(5),start.state,now+7000);
 expect(stale.facts[0]!.urgency).toMatchObject({active:true,requests:4});
 const five=assessUrgency([facts('p/a',100,now+6000)],requests(5),four.state,now+7000);
 expect(five.facts[0]!.urgency).toMatchObject({active:false,requests:5});
 const again=assessUrgency([facts('p/a',100,now+10000)],requests(5),five.state,now+11000);
 expect(again.facts[0]!.urgency?.active).toBe(false);
});

test('actual decrease starts a fresh observation; missing/old/backdated reads never claim unchanged',()=>{
 const start=assessUrgency([facts()],[],{},now);
 const changed=assessUrgency([facts('p/a',90,now+6000)],requests(5),start.state,now+7000);
 expect(changed.facts[0]!.urgency).toMatchObject({active:true,amount:90,requests:0});
 expect(assessUrgency([facts('p/a',100,now-16*60000)],[],{},now).facts[0]!.urgency).toBeUndefined();
 const missing=facts();delete missing.accounts[0]!.readAt;
 expect(assessUrgency([missing],[],{},now).facts[0]!.urgency).toBeUndefined();
 const reverted=assessUrgency([facts('p/a',100,now-1000)],[],changed.state,now+8000);
 expect(reverted.facts[0]!.urgency?.active).toBe(false); // an older inconsistent reading must not be promoted
});

test('requests on the same real pool are shared across models and effort variants, never across accounts',()=>{
 const a=facts('p/a:max'),b=facts('p/b'),other=facts('q/c');other.accounts[0]!.poolKey='other';
 const start=assessUrgency([a,b,other],[],{},now);
 const newer=[a,b,other].map(f=>({...f,accounts:f.accounts.map(a=>({...a,readAt:iso(now+10000)}))}));
 const r=assessUrgency(newer,[...requests(3),...requests(2,'p/b').map(r=>({...r,id:'b'+r.id}))],start.state,now+11000);
 expect(r.facts.map(f=>f.urgency?.active)).toEqual([false,false,true]);
});

test('expired, distant, zero, text/unlimited pools and auto-renew subscriptions do not qualify',()=>{
 for(const d of [now-1,now+25*3600000]){
  const f=facts();f.accounts[0]!.windows![0]!.runsOutAt=iso(d);expect(assessUrgency([f],[],{},now).facts[0]!.urgency).toBeUndefined();
 }
 expect(assessUrgency([facts('p/a',0)],[],{},now).facts[0]!.urgency).toBeUndefined();
 const f=facts();f.accounts[0]!.windows=[];f.accounts[0]!.until=iso(now+3600000);f.accounts[0]!.renew='auto';
 expect(assessUrgency([f],[],{},now).facts[0]!.urgency).toBeUndefined();
 f.accounts[0]!.renew='off';expect(assessUrgency([f],[],{},now).facts[0]!.urgency?.kind).toBe('subscription');
});

test('known grant reset qualifies; rolling short caps do not; a new deadline re-admits a new batch',()=>{
 const f=facts();f.accounts[0]!.windows=[{name:'5 hours',remainingPct:80,resetsAt:iso(now+3600000)}];
 expect(assessUrgency([f],[],{},now).facts[0]!.urgency).toBeUndefined();
 f.accounts[0]!.windows[0]!.name='Weekly';expect(assessUrgency([f],[],{},now).facts[0]!.urgency?.kind).toBe('reset');
 const started=assessUrgency([facts()],[],{},now);const end=assessUrgency([facts('p/a',100,now+6000)],requests(5),started.state,now+7000);
 const next=facts('p/a',100,now+8000);next.accounts[0]!.windows![0]!.runsOutAt=iso(now+7200000);
 expect(assessUrgency([next],[],end.state,now+9000).facts[0]!.urgency).toMatchObject({active:true,requests:0});
});

test('quota metadata preserves deadlines and anonymizes accounts; model-specific trial is separate from exhausted weekly allowance',()=>{
 const q=quotaAccounts([{provider:'p',user:'private@example.com',kind:'subscription',readAt:iso(now),windows:[{name:'Weekly',remaining:0,resetsAt:iso(now+86400000)},{name:'Flash-Trial',remaining:53.12,resetsAt:iso(now+3600000)},{name:'sign-in',text:true,remaining:100},{name:'unlimited',unlimited:true,remaining:100}]}],now);
 const f=modelFacts(['p/Flash-Trial:max','p/normal'],{catalog:[{id:'p/Flash-Trial'},{id:'p/normal'}],quota:q,usage:new Map(),performance:new Map()});
 expect(f[0]!.accounts[0]!.remainingPct).toBe(53.12);expect(f[1]!.accounts[0]!.remainingPct).toBe(0);expect(JSON.stringify(f)).not.toContain('private@example.com');
});

test('native log threshold is strictly >50k, includes cache tokens, rejects errors and uses completion time',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sck-urgent-'));
 try{
 const record=(patch:Record<string,unknown>)=>({t:iso(now),provider:'p',model:'a',status:200,in:50001,ms:1000,...patch});
 const rows=[record({in:50000}),record({in:10}),record({status:429}),record({err:'failed'}),record({rejected:true}),record({handed_on:true}),record({in:1,cache_read:30000,cache_write:20000}),record({in:50001}),record({ms:90000})];
 const file=join(dir,'usage.jsonl');await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n'));
 const result=await readUsageSamples(now+10000,file);expect(result.largeRequests).toHaveLength(2);expect(result.largeRequests![0]!.at).toBe(now+1000);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unchanged batches stay excluded across restart and duplicate log reads; state is private and numeric',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sck-urgent-'));
 try{
 const path=join(dir,'state.json');await new UrgencyTracker(path).update([facts()],[],now);
 const f=await new UrgencyTracker(path).update([facts('p/a',100,now+7000)],[...requests(5),...requests(5)],now+8000);
 expect(f[0]!.urgency).toMatchObject({active:false,requests:5});
 expect((await new UrgencyTracker(path).update([facts('p/a',100,now+9000)],requests(5),now+10000))[0]!.urgency?.active).toBe(false);
 expect(await readFile(path,'utf8')).not.toContain('p/a');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Zcode-style one-off model trial is urgent even when the ordinary weekly allowance is exhausted',()=>{
 const q=quotaAccounts([{provider:'p',user:'one',kind:'subscription',readAt:iso(now),windows:[{name:'Weekly',remaining:0,resetsAt:iso(now+86400000)},{name:'Flash-Trial',remaining:53.12,resetsAt:iso(now+3600000)}]}],now);
 const f=modelFacts(['p/Flash-Trial:max','p/ordinary'],{catalog:[{id:'p/Flash-Trial'},{id:'p/ordinary'}],quota:q,usage:new Map(),performance:new Map()});
 const assessed=assessUrgency(f,[],{},now).facts;
 expect(assessed[0]!.urgency).toMatchObject({active:true,kind:'gift',amount:53.12,unit:'%'});
 expect(ruleOrder(assessed,[],now)[0]!.decision.urgent).toBe(true);expect(assessed[1]!.urgency).toBeUndefined();
});

test('controller refreshes the expiring remote card and suppresses an unchanged pool after real native usage, across restart',async()=>{
 const {ModelRoutingController}=await import('../src/model-routing/controller.ts');
 const dir=await mkdtemp(join(tmpdir(),'sck-urgent-'));
 try{
 const log=join(dir,'usage.jsonl');await writeFile(log,'');let clock=now;const calls:string[]=[];
 const quota=(readAt:number)=>[{provider:'remote-magpie/codearts',user:'private',kind:'subscription',readAt:iso(readAt),windows:[{name:'Credits',remaining:80,runsOut:100,runsOutAt:iso(now+3600000),unit:'credits'}]}];
 const io={now:()=>clock,usageLog:log,routingLogDir:join(dir,'absent'),output:async(args:string[])=>{calls.push(args.join(' '));return JSON.stringify(args[1]==='refresh'?quota(clock):quota(now));},fetch:(async()=>Response.json({period:'7d',models:[]})) as unknown as typeof fetch};
 const model='remote-magpie/codearts/a';const controller=()=>new ModelRoutingController({query:async()=>[[]]} as never,dir,'unused',io);
 expect((await controller().rankingFacts([model]))[0]!.urgency?.active).toBe(true);
 const rows=Array.from({length:5},(_,i)=>({t:iso(now+(i+1)*1000),provider:'remote-magpie',model:'codearts/a',status:200,in:50001,ms:100}));
 await writeFile(log,rows.map(r=>JSON.stringify(r)).join('\n'));clock=now+45000;
 const result=await controller().rankingFacts([model]);expect(calls).toContain('quota refresh remote-magpie/codearts --json');
 expect(result[0]!.urgency).toMatchObject({active:false,requests:5});
 expect((await controller().rankingFacts([model]))[0]!.urgency?.active).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
