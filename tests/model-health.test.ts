import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {readModelHealth} from '../src/model-routing/health.ts';
import {ModelRoutingController} from '../src/model-routing/controller.ts';
import {RankingRefresher,rankingTables,type ModelFacts} from '../src/model-routing/ranking.ts';
const now=Date.parse('2026-10-25T02:00:00Z');
const dirs:string[]=[];const scratch=()=>{const d=mkdtempSync(join(tmpdir(),'sck-health-'));dirs.push(d);return d;};
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const attempt=(model:string,status:number,i=0)=>({id:'remote-magpie',model,effort:'max',start:new Date(now-100000+i*1000).toISOString(),done:true,status,ms:100});
const route=(tries:unknown[],id='route')=>JSON.stringify({id,tries});
test('routing attempts catch a denied member absent from native usage, without borrowing another provider or alias',async()=>{
 const home=scratch(),routing=join(home,'routing');mkdirSync(routing);
 writeFileSync(join(routing,'2026-10-24.jsonl'),route([attempt('sn/deepseek-v4.1-flash',403)]));
 const health=await readModelHealth(now,routing);
 expect(health.get('remote-magpie/sn/deepseek-v4.1-flash')).toMatchObject({excluded:true,reason:'unavailable',attempts:1,errors:1,lastStatus:403});
 expect(health.has('other/sn/deepseek-v4.1-flash')).toBe(false);
 expect(health.has('remote-magpie/sn/deepseek-flash')).toBe(false);
 const c=new ModelRoutingController({query:async()=>[[]]} as any,home,'unused',{now:()=>now,routingLogDir:routing,usageLog:join(home,'missing'),output:async()=> '[]',fetch:(async()=>Response.json({period:'7d',models:[]})) as unknown as typeof fetch});
 const facts=await c.rankingFacts(['remote-magpie/sn/deepseek-v4.1-flash:max']);
 expect(facts[0]?.health?.excluded).toBe(true);expect(facts[0]?.usage).toBeUndefined();
});
test('all failed retries count, snapshots deduplicate, canceled and unfinished calls do not condemn a model, later success recovers',async()=>{
 const routing=scratch();
 const bad=route([attempt('bad',503,0),attempt('bad',503,1),attempt('bad',503,2)]);
 writeFileSync(join(routing,'2026-10-24.jsonl.gz'),gzipSync(bad+'\n'+bad+'\n'+route([attempt('cancel',499),{...attempt('open',503),done:false}], 'cancel')));
 let health=await readModelHealth(now,routing);
 expect(health.get('remote-magpie/bad')).toMatchObject({excluded:true,reason:'consecutive_errors',attempts:3,errors:3,consecutiveErrors:3});
 expect(health.has('remote-magpie/cancel')).toBe(false);expect(health.has('remote-magpie/open')).toBe(false);
 writeFileSync(join(routing,'2026-10-25.jsonl'),route([attempt('bad',200,3)],'recover'));
 health=await readModelHealth(now,routing);expect(health.get('remote-magpie/bad')?.excluded).toBe(false);
 expect(await readModelHealth(now,join(routing,'missing'))).toEqual(new Map());
});
test('a transient failing streak cools down, while a hard refusal is remembered for the whole window',async()=>{
 const routing=scratch(),old=(model:string,status:number,i:number)=>({...attempt(model,status,i),start:new Date(now-2*3600_000+i*1000).toISOString()});
 writeFileSync(join(routing,'2026-10-24.jsonl'),route([old('busy',200,0),old('busy',429,1),old('busy',429,2),old('busy',429,3),old('gone',403,4),old('flaky',503,5),old('flaky',503,6),old('flaky',200,7),old('flaky',503,8),old('flaky',503,9)]));
 const health=await readModelHealth(now,routing);
 expect(health.get('remote-magpie/busy')).toMatchObject({excluded:false,consecutiveErrors:3});
 expect(health.get('remote-magpie/flaky')?.excluded).toBe(false);
 expect(health.get('remote-magpie/gone')).toMatchObject({excluded:true,reason:'unavailable'});
});
test('isolated transient errors and unknown models remain eligible, high recent error rates are excluded',async()=>{
 const routing=scratch();
 writeFileSync(join(routing,'2026-10-24.jsonl'),route([attempt('mixed',503),attempt('mixed',200,1),attempt('mixed',503,2),attempt('mixed',503,3),attempt('mixed',503,4),attempt('single',500)]));
 const health=await readModelHealth(now,routing);
 expect(health.get('remote-magpie/mixed')?.excluded).toBe(true);expect(health.get('remote-magpie/single')?.excluded).toBe(false);
});
const fact=(id:string):ModelFacts=>({id,accounts:[],price:{free:false}});
test('health gate excludes denied members from Jev, overrides pins, and persists reasons with no fake Jev scores',async()=>{
 const bad='remote-magpie/sn/deepseek-v4.1-flash:max', good='p/good', pinned='p/pinned';
 const facts=[{...fact(bad),health:{source:'magpie-routing' as const,excluded:true,reason:'unavailable' as const,attempts:1,errors:1,consecutiveErrors:1,lastStatus:403,lastAttemptAt:new Date(now).toISOString()}},fact(good),fact(pinned)];
 let members=[bad,good,pinned];const writes:any[]=[];const sent:string[][]=[];
 const db={query:async(sql:string,v?:any)=>{if(sql.startsWith('SELECT pins'))return [{pins:{'sck-haiku':[bad,pinned]}}];if(sql.startsWith('SELECT ranking_rules'))return [{}];writes.push(v);return [undefined];}};
 const r=new RankingRefresher({db:db as any,groups:()=>({'sck-haiku':members}),facts:async()=>facts,apply:async orders=>{members=orders['sck-haiku']!;},jev:{model:'fixture',ask:async(s:any,q)=>{sent.push(Object.values(s.models).map((f:any)=>f.id));return {model:'fixture',answers:Object.fromEntries(Object.keys(q).map(k=>[k,{type:'score' as const,score:4}]))};}}});
 r.trigger();await r.settled();expect(sent).toEqual([[good]]);expect(members).toEqual([pinned,good,bad]);
 const result=writes.find(v=>v?.results)?.results;
 const table=rankingTables({'sck-haiku':members},result,[],{'sck-haiku':[bad,pinned]})[0]!;
 expect(table.rows.at(-1)).toMatchObject({model:bad,health:{excluded:true,reason:'unavailable'}});expect(table.rows.at(-1)?.jevScore).toBeUndefined();
});
test('all unhealthy groups still publish their tail without Jev; Jev failure cannot keep unhealthy members first',async()=>{
 for(const allBad of [false,true]){
  const bad={...fact('p/bad'),health:{source:'magpie-routing' as const,excluded:true,reason:'consecutive_errors' as const,attempts:3,errors:3,consecutiveErrors:3,lastStatus:503,lastAttemptAt:new Date(now).toISOString()}};
  let members=allBad?['p/bad']:['p/bad','p/good'];let calls=0;const writes:any[]=[];
  const r=new RankingRefresher({db:{query:async(sql:string,v?:any)=>{writes.push(v);return [{}];}} as any,groups:()=>({'sck-haiku':members}),facts:async()=>allBad?[bad]:[bad,fact('p/good')],apply:async orders=>{members=orders['sck-haiku']!;},jev:{model:'fixture',ask:async()=>{calls++;throw Error('Jev down');}}});
  r.trigger();await r.settled();expect(calls).toBe(allBad?0:1);expect(members.at(-1)).toBe('p/bad');expect(writes.find(w=>w?.gates)?.gates['sck-haiku'].facts.find((f:any)=>f.id==='p/bad').health.excluded).toBe(true);
  expect(writes.find(w=>w?.results)?.results).toEqual({});
 }
});
test('both owner surfaces explain a demoted member, and the browser copy runs standalone',async()=>{
 const {rankingHealthMetric}=await import('../plugin/shared/ranking-trends.ts');
 const {rankingPage}=await import('../plugin/server/ranking-page.ts');
 const denied={excluded:true,reason:'unavailable' as const,attempts:1,errors:1,consecutiveErrors:1,lastStatus:403};
 expect(rankingHealthMetric(denied)).toEqual({value:'1/1 失败',detail:expect.stringContaining('HTTP 403：已移到组末尾，不参与 JEV 排序')});
 expect(rankingHealthMetric(undefined).value).toBe('未知');
 const script=rankingPage.match(/<script>([\s\S]*?)<\/script>/)![1]!;
 const start=script.indexOf('const healthMetric=')+'const healthMetric='.length;
 const embedded=new Function(`return (${script.slice(start,script.indexOf('\nfunction metrics',start)).replace(/;\s*$/,'')});`)() as typeof rankingHealthMetric;
 expect(embedded(denied)).toEqual(rankingHealthMetric(denied));
});
