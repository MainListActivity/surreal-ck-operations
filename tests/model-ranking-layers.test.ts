import {expect,test} from 'bun:test';
import {rankingLayers} from '../plugin/shared/ranking-layers.ts';
import {rankingTables,type ModelFacts} from '../src/model-routing/ranking.ts';
import {DEFAULT_POLICY} from '../src/model-routing/weights.ts';
import type {ModelRankingTable} from '../plugin/shared/types.ts';
const row=(model:string,band=0,costClass:'free'|'included'|'unknown'|'paid'='included',score=10)=>({model,aaScore:45.1,accounts:[],decision:{band,costClass,score,coldStart:false,latencySource:'unknown' as const,billing:'subscription' as const,quota:'available' as const,reason:''}});
const table=(rows:ModelRankingTable['rows']):ModelRankingTable=>({group:'sck-haiku',scored:true,bandWidth:2,bandRanges:{'["",0]':{top:45.1,bottom:43.1},'["",1]':{top:42.7,bottom:40.7}},rows});
test('manual pins are one independent first layer; other boundaries preserve native order',()=>{
 const rows=[{...row('p/pinned'),pinned:true},row('p/a'),row('p/expensive',0,'unknown',80),row('p/weaker',1,'included',90)];
 const before=JSON.stringify(rows),layers=rankingLayers(table(rows));
 expect(layers.map(l=>[l.start,l.end])).toEqual([[0,0],[1,1],[2,2],[3,3]]);
 expect(layers[0]!.title).toBe('第1层 · 手动置顶');expect(layers[1]!.title).toContain('套餐/积分覆盖');expect(layers[2]!.title).toContain('计费未知');
 expect(layers[3]!.title).toContain('能力档2');expect(layers[0]!.comparison).toContain('置顶先后排列');expect(JSON.stringify(rows)).toBe(before);
 expect(layers[1]!.abilitySummary).toContain('43.1–45.1');expect(layers[1]!.ability).toContain('分差≤2');
});
test('exploration, concrete model failure, unknown AA and unpublished members remain distinguishable',()=>{
 const fresh=row('p/new');fresh.decision.coldStart=true;
 const bad={...row('p/bad'),decision:{...row('p/bad').decision,tail:'该模型持续报错'}};
 const unknown=row('p/unknown');delete (unknown.decision as {band?:number}).band;
 const layers=rankingLayers(table([fresh,row('p/a'),bad,unknown,{model:'p/unpublished',accounts:[]}]));
 expect(layers).toHaveLength(5);expect(layers[0]!.title).toContain('新模型试用');expect(layers[2]!.title).toContain('该模型持续报错');expect(layers[3]!.abilitySummary).toContain('未知档');expect(layers[4]!.title).toContain('待分层');
 expect(rankingLayers(table([]))).toEqual([]);
});
test('a manually separated layer keeps the same identity and explicitly marks continuation',()=>{
 const layers=rankingLayers(table([row('a'),row('b',1),row('c')]));
 expect(layers.map(l=>l.number)).toEqual([1,2,1]);expect(layers[2]!.title).toContain('（续）');expect(layers[2]!.total).toBe(2);
});
test('snapshot metadata keeps the original band top after a member is removed, independent of new settings',()=>{
 const facts=(id:string,score:number):ModelFacts=>({id,aa:{score,rank:1},accounts:[],price:{free:false}});
 const result={engine:'quality-pace-v2',policy:structuredClone(DEFAULT_POLICY),tier:'haiku' as const,model:'quality-pace-v2',at:'2026-10-27T10:00:00Z',rules:'fixed',answers:{},rows:[{facts:facts('removed',45.1),decision:row('removed').decision},{facts:facts('remaining',43.7),decision:row('remaining').decision}]};
 const t=rankingTables({'sck-haiku':['remaining']},{'sck-haiku':result})[0]!;
 expect(t.bandWidth).toBe(2);expect(t.bandRanges?.['["",0]']).toEqual({top:45.1,bottom:43.1});expect(rankingLayers(t)[0]!.abilitySummary).toContain('43.1–45.1');
 const legacy=rankingLayers({...t,bandWidth:undefined,bandRanges:undefined})[0]!;expect(legacy.abilitySummary).toContain('未记录');
});
test('web embedding of the shared helper has no module-scope dependencies',()=>{
 const embedded=new Function('return ('+rankingLayers.toString()+')')();
 expect(embedded(table([row('a')]))).toEqual(rankingLayers(table([row('a')])));
});
test('all pins share the first layer even when their automatic risks, AA and billing differ',()=>{
 const bad={...row('p/bad',2,'paid'),pinned:true,decision:{...row('p/bad',2,'paid').decision,tail:'该模型持续报错'}};
 const spent={...row('p/spent',0,'unknown'),pinned:true,decision:{...row('p/spent',0,'unknown').decision,tail:'供应商已知账号额度耗尽'}};
 const layers=rankingLayers(table([bad,spent,row('p/healthy')]));
 expect(layers[0]!.title).toBe('第1层 · 手动置顶');expect(layers[0]!.count).toBe(2);expect(layers[0]!.explanation).toContain('当前风险');expect(layers[0]!.abilitySummary).toContain('2个模型');expect(layers[1]!.number).toBe(2);
});
