import {expect,test} from 'bun:test';
import {DEFAULT_POLICY} from '../src/model-routing/weights.ts';
import {CompanyDatabase} from '../src/database.ts';
import {loadDatabaseConfig} from '../src/config.ts';
import {RankingRefresher,rankingSettings,saveRankingSettings,rankingRequests,DEFAULT_RANKING_RULES,rankingTables,rankingPins} from '../src/model-routing/ranking.ts';
const run=process.env.RUN_SCK_CHANNEL_FORK_TESTS==='1'?test:test.skip;
run('fork: deterministic ranking persists across reconnect without Jev or overwriting other routing config',async()=>{
 const config={...loadDatabaseConfig(),namespace:'ranking_fixture',database:'control_plane'};
 const db=new CompanyDatabase(config);
 try{
  await db.connect();await db.bootstrap();
  await db.db.query("UPSERT company_meta:model_routing CONTENT {enabled:true,disabledModels:['keep/excluded'],ranking_rules:'old prose'};");
  expect(await rankingRequests(db.db)).toEqual([]);
  const applied:Record<string,string[]>[]=[];let calls=0;
  const facts=async(ids:string[])=>ids.map(id=>({id,accounts:[{account:'anonymous',kind:'subscription' as const,remainingPct:80}],aa:{score:60,rank:1},price:{free:false},usage:{source:'magpie' as const,period:'7d' as const,scope:'provider-model' as const,collectedAt:new Date().toISOString(),requests:10,errors:0,speedSamples:0,ttftSamples:10,ttftMs:id==='a/slow'?20001:500}}));
  const refresher=new RankingRefresher({db:db.db,groups:()=>({'sck-opus':['manual/a'],'sck-sonnet':['a/slow','a/fast'],'sck-haiku':['a/slow','a/fast'],'sck-fable':['manual/b']}),facts,apply:async orders=>{applied.push(orders);},jev:{model:'must-not-call',ask:async()=>{calls++;throw Error('must never call Jev');}}});
  await saveRankingSettings(db.db,{rules:'ignored legacy prose',refreshMinutes:2},refresher);
  expect(await rankingSettings(db.db)).toEqual({rules:DEFAULT_RANKING_RULES,refreshMinutes:2,policy:DEFAULT_POLICY});
  const [c]=await db.db.query<[any]>('SELECT * FROM ONLY company_meta:model_routing;');expect(c).toMatchObject({enabled:true,disabledModels:['keep/excluded'],ranking_rules:DEFAULT_RANKING_RULES});
  await db.db.query("UPSERT company_meta:model_ranking CONTENT {orders:{kept:['old/model']},pins:{'sck-haiku':['a/slow']}};");
  refresher.trigger(0);await refresher.settled();expect(calls).toBe(0);expect(applied).toEqual([{'sck-sonnet':['a/fast','a/slow'],'sck-haiku':['a/fast','a/slow']}]);
  expect(await rankingRequests(db.db)).toEqual([]);
  const [status]=await db.db.query<[any]>('SELECT * FROM ONLY company_meta:model_ranking;');
  expect(status.orders.kept).toEqual(['old/model']);expect(status.results['sck-haiku']).toMatchObject({engine:'quality-pace-v2',answers:{}});
  expect(status.results['sck-haiku'].rows[0].score).toBeUndefined();expect(status.results['sck-haiku'].rows[1].decision.tail).toContain('20秒');
  const reconnected=new CompanyDatabase(config);try{
   await reconnected.connect();await reconnected.useDatabase();
   const [stored]=await reconnected.db.query<[any]>('SELECT results FROM ONLY company_meta:model_ranking;');
   const table=rankingTables({'sck-haiku':['a/fast','a/slow']},stored.results,[],await rankingPins(reconnected.db))[0]!;
   expect(table.rows[0]!.decision?.ttftMs).toBe(500);expect(table.rows[1]!.tailReason).toContain('20秒');expect(table.rows[1]!.jevScore).toBeUndefined();
  }finally{await reconnected.close();}
  const failed=new RankingRefresher({db:db.db,groups:()=>({'sck-haiku':['changed']}),facts,apply:async()=>{throw Error('apply failed');}});
  failed.trigger(0);await failed.settled();
  const [after]=await db.db.query<[any]>('SELECT orders,error FROM ONLY company_meta:model_ranking;');expect(after.orders).toEqual(status.orders);expect(after.error).toBeDefined();
 }finally{await db.close();}
});
