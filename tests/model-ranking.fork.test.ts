import {expect,test} from 'bun:test';
import {CompanyDatabase} from '../src/database.ts';
import {loadDatabaseConfig} from '../src/config.ts';
import {RankingRefresher,rankingSettings,saveRankingSettings,rankingRequests,DEFAULT_RANKING_RULES,rankingTables,rankingPins} from '../src/model-routing/ranking.ts';
const run=process.env.RUN_SCK_CHANNEL_FORK_TESTS==='1'?test:test.skip;
run('fork: ranking settings preserve routing config; request-triggered two-group results persist',async()=>{
 const db=new CompanyDatabase({...loadDatabaseConfig(),namespace:'ranking_fixture',database:'control_plane'});
 try{
  await db.connect();await db.bootstrap();
  await db.db.query("UPSERT company_meta:model_routing CONTENT {enabled:true,disabledModels:['keep/excluded']};");
  expect(await rankingRequests(db.db)).toEqual([]);
  const sent:any[]=[];const applied:unknown[]=[];let calls=0;
  const refresher=new RankingRefresher({db:db.db,groups:()=>({'sck-opus':['a/x','a/y'],'sck-sonnet':['a/x'],'sck-haiku':['a/y'],'sck-fable':['owner/z']}),facts:async ids=>ids.map(id=>({id,accounts:[],price:{free:true,input:0,output:0,cacheHit:0}})),apply:async orders=>{applied.push(orders);},jev:{model:'fixture',ask:async(state,questions)=>{calls++;
    const snapshots=await rankingRequests(db.db);
    const snapshot=snapshots.find(s=>`group/sck-${s.tier}`===(state as any).group)!;
    expect(snapshot.payload).toEqual(JSON.parse(JSON.stringify({model:'fixture',state,questions})));
    sent.push(snapshot);return {model:'fixture',answers:Object.fromEntries(Object.keys(questions).map((k,i)=>[k,{type:'score' as const,score:i,confidence:0.99}]))};}}});
  expect(await rankingSettings(db.db)).toEqual({rules:DEFAULT_RANKING_RULES,refreshMinutes:5});
  await saveRankingSettings(db.db,{rules:'免费优先',refreshMinutes:2},refresher);
  const [config]=await db.db.query<[any]>('SELECT * FROM ONLY company_meta:model_routing;');
  expect(config).toMatchObject({enabled:true,disabledModels:['keep/excluded'],ranking_rules:'免费优先',ranking_refresh_minutes:2});
  await db.db.query("UPSERT company_meta:model_ranking CONTENT {orders:{kept:['old/model']}};");
  refresher.trigger(0);await refresher.settled();expect(calls).toBe(2);expect(applied).toHaveLength(1);
  const [status]=await db.db.query<[any]>('SELECT * FROM ONLY company_meta:model_ranking;');
  expect(status.orders).toEqual({kept:['old/model'],'sck-sonnet':['a/x'],'sck-haiku':['a/y']});expect(status.refresh_minutes).toBe(2);expect(status.at).toBeDefined();
  expect(status.results['sck-sonnet']).toMatchObject({tier:'sonnet',rules:'免费优先',model:'fixture'});
  expect(status.results['sck-sonnet'].rows.map((r:any)=>[r.facts.id,r.score])).toEqual([['a/x',0]]);
  expect(status.results['sck-sonnet'].answers.m0.score).toBe(0);
  expect((await rankingRequests(db.db)).map(s=>s.tier)).toEqual(['sonnet','haiku']);
  await saveRankingSettings(db.db,{rules:'质量优先',refreshMinutes:2},refresher);
  expect(await rankingRequests(db.db)).toEqual(sent); // editing rules cannot rewrite historical input
  refresher.trigger(1);await refresher.settled();
  expect(await rankingRequests(db.db)).toHaveLength(2); // bounded even after another refresh
  expect((await rankingRequests(db.db))[0]!.payload.state.ownerRules).toBe('质量优先');
  const failed=new RankingRefresher({db:db.db,groups:()=>({'sck-haiku':['p/failed']}),facts:async ids=>ids.map(id=>({id,accounts:[],price:{free:false}})),apply:async()=>{throw Error('must retain prior orders');},jev:{model:'failed-fixture',ask:async()=>{throw Error('private upstream text');}}});
  failed.trigger();await failed.settled();
  const afterFailure=await rankingRequests(db.db);
  expect(afterFailure).toHaveLength(2);
  expect(afterFailure.find(s=>s.tier==='haiku')!.payload.model).toBe('failed-fixture');
  const [kept]=await db.db.query<[any]>('SELECT orders,error,results FROM ONLY company_meta:model_ranking;');
  expect(kept.orders).toEqual(status.orders);expect(kept.error).toBe('haiku 刷新失败，保留原顺序');
  expect(kept.results['sck-haiku'].rules).toBe('质量优先');
  await expect(refresher.setPin('sck-opus','a/x',true)).rejects.toThrow();
  await refresher.setPin('sck-sonnet','a/x',true);
  expect(await rankingPins(db.db)).toEqual({'sck-sonnet':['a/x']});
  refresher.trigger(5);await refresher.settled();
  expect((await rankingRequests(db.db)).find(s=>s.tier==='haiku')!.payload.state.models).toEqual({m0:{id:'a/y',accounts:[],price:{free:true,input:0,output:0,cacheHit:0}}});
  const reconnected=new CompanyDatabase({...loadDatabaseConfig(),namespace:'ranking_fixture',database:'control_plane'});
  try {
    await reconnected.connect();await reconnected.useDatabase();
    const [persisted]=await reconnected.db.query<[any]>('SELECT results FROM ONLY company_meta:model_ranking;');
    const tables=rankingTables({'sck-haiku':['a/y']},persisted.results,await rankingRequests(reconnected.db));
    expect((await rankingPins(reconnected.db))['sck-opus']).toBeUndefined();
    expect(tables[0]).toMatchObject({scored:true,rules:'质量优先',rows:[{model:'a/y',jevScore:0}]});
  } finally {await reconnected.close();}
 }finally{await db.close();}
});
