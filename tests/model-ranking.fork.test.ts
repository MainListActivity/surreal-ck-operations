import {expect,test} from 'bun:test';
import {CompanyDatabase} from '../src/database.ts';
import {loadDatabaseConfig} from '../src/config.ts';
import {RankingRefresher,rankingSettings,saveRankingSettings} from '../src/model-routing/ranking.ts';
const run=process.env.RUN_SCK_CHANNEL_FORK_TESTS==='1'?test:test.skip;
run('fork: ranking settings preserve routing config; request-triggered three-group results persist',async()=>{
 const db=new CompanyDatabase({...loadDatabaseConfig(),namespace:'ranking_fixture',database:'control_plane'});
 try{
  await db.connect();await db.bootstrap();
  await db.db.query("UPSERT company_meta:model_routing CONTENT {enabled:true,disabledModels:['keep/excluded']};");
  const applied:unknown[]=[];let calls=0;
  const refresher=new RankingRefresher({db:db.db,groups:()=>({'sck-opus':['a/x','a/y'],'sck-sonnet':['a/x'],'sck-haiku':['a/y'],'sck-fable':['owner/z']}),facts:async ids=>ids.map(id=>({id,accounts:[],price:{free:true,input:0,output:0,cacheHit:0}})),apply:async orders=>{applied.push(orders);},jev:{model:'fixture',ask:async(_state,questions)=>{calls++;return {model:'fixture',answers:Object.fromEntries(Object.keys(questions).map((k,i)=>[k,{type:'score' as const,score:i,confidence:0.99}]))};}}});
  expect(await rankingSettings(db.db)).toEqual({rules:'',refreshMinutes:5});
  await saveRankingSettings(db.db,{rules:'免费优先',refreshMinutes:2},refresher);
  const [config]=await db.db.query<[any]>('SELECT * FROM ONLY company_meta:model_routing;');
  expect(config).toMatchObject({enabled:true,disabledModels:['keep/excluded'],ranking_rules:'免费优先',ranking_refresh_minutes:2});
  await db.db.query("UPSERT company_meta:model_ranking CONTENT {orders:{kept:['old/model']}};");
  refresher.trigger(0);await refresher.settled();expect(calls).toBe(3);expect(applied).toHaveLength(1);
  const [status]=await db.db.query<[any]>('SELECT * FROM ONLY company_meta:model_ranking;');
  expect(status.orders).toEqual({kept:['old/model'],'sck-opus':['a/y','a/x'],'sck-sonnet':['a/x'],'sck-haiku':['a/y']});expect(status.refresh_minutes).toBe(2);expect(status.at).toBeDefined();
 }finally{await db.close();}
});
