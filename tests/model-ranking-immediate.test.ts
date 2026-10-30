import {test,expect} from 'bun:test';
import {RankingRefresher,saveRankingSettings,type ModelFacts} from '../src/model-routing/ranking.ts';
import {DEFAULT_POLICY} from '../src/model-routing/weights.ts';
import {updateModelMembership,updateModelAlias} from '../plugin/server/model-ranking.ts';

function fixture(){
 let policy=structuredClone(DEFAULT_POLICY),error:string|undefined;const published:any[]=[],snapshots:any[]=[];let reads=0;
 const facts:ModelFacts[]=['p/a','p/b'].map((id,index)=>({id,accounts:[],aa:{rank:index+1,score:60-index*20},price:{free:false,input:1,output:2},usage:{source:'magpie',period:'7d',collectedAt:new Date().toISOString(),scope:'provider-model',requests:10,errors:0,speedSamples:10,ttftSamples:10,tokensPerSecond:100,ttftMs:1000+index*5000}}));
 const db={query:async(sql:string,v?:any)=>{
  if(sql.startsWith('SELECT ranking_rules'))return [{ranking_policy:policy,ranking_refresh_minutes:10}];
  if(sql.startsWith('SELECT pins'))return [{}];
  if(sql.startsWith('SELECT results,gates'))return [{results:{'sck-haiku':{rows:facts.map(facts=>({facts}))}}}];
  if(sql.includes('UPSERT company_meta:model_routing MERGE'))policy=v.policy;
  if(v?.results)snapshots.push(v.results);
  if(sql.includes("error:'刷新失败"))error='failed';
  return [undefined];
 }};
 const deps={db:db as any,groups:()=>({'sck-haiku':facts.map(f=>f.id)}),facts:async()=>{reads++;return facts;},apply:async(o:any)=>{published.push(o);}};
 return {deps,db,published,snapshots,reads:()=>reads,error:()=>error};
}
test('save applies cached facts before returning without a gateway request or remote observation',async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void,finished=false;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const r=new RankingRefresher({...f.deps,apply:async o=>{f.published.push(o);entered();await gate;}});
 const policy={...DEFAULT_POLICY,weights:{...DEFAULT_POLICY.weights,latency:91}};
 const saving=saveRankingSettings(f.db as any,{rules:'',refreshMinutes:10,policy},r).then(()=>{finished=true;});
 await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('save never applied ranking')),500))]);
 expect(f.reads()).toBe(0);expect(finished).toBe(false);release();await saving;
 expect(f.snapshots.at(-1)['sck-haiku'].policy.weights.latency).toBe(91);expect(f.published).toHaveLength(1);
});
test('a delayed background observation cannot overwrite an immediately saved policy',async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const r=new RankingRefresher({...f.deps,facts:async()=>{entered();await gate;return [] as ModelFacts[];}});
 r.trigger();await started;
 await saveRankingSettings(f.db as any,{rules:'',refreshMinutes:10,policy:{...DEFAULT_POLICY,weights:{...DEFAULT_POLICY.weights,price:99}}},r);
 expect(f.published).toHaveLength(1);release();await r.settled();expect(f.published).toHaveLength(1);
 expect(f.snapshots.at(-1)['sck-haiku'].policy.weights.price).toBe(99);
});
test('save reports an apply failure instead of reporting a queued change as success',async()=>{
 const f=fixture();const r=new RankingRefresher({...f.deps,apply:async()=>{throw Error('Magpie unavailable');}});
 await expect(saveRankingSettings(f.db as any,{rules:'',refreshMinutes:10},r)).rejects.toThrow();
 expect(f.error()).toBe('failed');
});
test('billing overrides immediately reverse the actual applied order using the same observations',async()=>{
 const f=fixture(),r=new RankingRefresher(f.deps);
 await saveRankingSettings(f.db as any,{rules:'',refreshMinutes:10},r);
 expect(f.published.at(-1)['sck-haiku']).toEqual(['p/a','p/b']);
 const policy={...DEFAULT_POLICY,weights:{staleness:20,pace:0,latency:0,intelligence:0,speed:0,performance:0,price:100},billingOverrides:{'p/b':'free' as const,'p/a':'paid' as const}};
 await saveRankingSettings(f.db as any,{rules:'',refreshMinutes:10,policy},r);
 expect(f.published.at(-1)['sck-haiku']).toEqual(['p/b','p/a']);expect(f.reads()).toBe(0);
});
test('shared membership and AA handlers await refreshed facts and applied orders',async()=>{
 const f=fixture();let members=['p/a','p/b'];f.deps.groups=()=>({'sck-haiku':members});
 const ranking=new RankingRefresher(f.deps);await saveRankingSettings(f.db as any,{rules:'',refreshMinutes:10},ranking);
 const ctx={db:{db:f.db},modelRanking:ranking,modelRouting:{setMembership:async()=>{members=['p/a'];},setAlias:async()=>({synchronized:true})}} as any;
 await updateModelMembership(ctx,{group:'sck-haiku',model:'p/b',present:false,expectedMembers:['p/b']});
 expect(f.published.at(-1)['sck-haiku']).toEqual(['p/a']);expect(f.reads()).toBe(1);
 await updateModelAlias(ctx,{model:'p/a',slug:'known-aa'});expect(f.reads()).toBe(2);expect(f.published).toHaveLength(3);
});
test('an older observation preview cannot replace facts from a subsequent AA edit',async()=>{
 const f=fixture();let release!:(facts:ModelFacts[])=>void,reads=0;
 const old=new Promise<ModelFacts[]>(resolve=>release=resolve);
 const facts=(score:number):ModelFacts[]=>['p/a','p/b'].map(id=>({id,accounts:[],price:{free:true},aa:{rank:1,score}}));
 const r=new RankingRefresher({...f.deps,facts:async()=>reads++===0?old:facts(80)});
 const preview=r.preview(DEFAULT_POLICY,true).catch(error=>error);
 await r.configure(async()=>{},5,true);release(facts(10));
 expect(await preview).toBeInstanceOf(Error);
 await saveRankingSettings(f.db as any,{rules:'',refreshMinutes:10},r);
 expect(f.snapshots.at(-1)['sck-haiku'].rows[0].facts.aa.score).toBe(80);
});
