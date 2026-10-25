import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {metricTrend,nativeDecode,readUsageSamples,GaugeHistory} from '../src/model-routing/trends.ts';
import {jevOrder} from '../src/model-routing/ranking.ts';
import {ModelRoutingController} from '../src/model-routing/controller.ts';
const now=Date.parse('2026-10-25T12:00:00Z'), minute=60000;
const dirs:string[]=[];const scratch=()=>{const d=mkdtempSync(join(tmpdir(),'sck-trends-'));dirs.push(d);return d;};
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
test('large historic sample counts cannot hide rising recent latency or a persistent step change',()=>{
 const history=Array.from({length:50000},(_,i)=>({at:now-2*60*minute-i,value:2000}));
 const rising=[2000,3000,5000,8000,12000,16000].map((value,i)=>({at:now-(5-i)*minute,value}));
 const t=metricTrend([...history,...rising],now,'ms','request');
 expect(t.current).toBe(16000);expect(t.ewma).toBeGreaterThan(7500);expect(t.slopePerMinute).toBeGreaterThan(2000);expect(t.baseline.mean).toBeLessThan(2002);expect(t.sufficient).toBe(true);
 const step=metricTrend([...history,...Array.from({length:5},(_,i)=>({at:now-(10-i)*minute,value:2000})),...Array.from({length:5},(_,i)=>({at:now-(4-i)*minute,value:15000}))],now,'ms','request');
 expect(step.change).toMatchObject({detected:true,direction:'up',before:2000,after:15000});
 const highFlat=metricTrend(Array.from({length:20},(_,i)=>({at:now-(19-i)*minute,value:15000})),now,'ms','request');
 expect(highFlat.slopePerMinute).toBe(0);expect(highFlat.current).toBe(15000);
});
test('slopes use actual elapsed minutes; sparse/stale/tied times do not invent confident trends',()=>{
 const a=Array.from({length:5},(_,i)=>({at:now-(4-i)*minute,value:10+i}));
 expect(metricTrend(a.map(r=>({...r,at:now-(now-r.at)/60})),now,'tokens/s','request').slopePerMinute).toBe(60);
 const b=a.map(r=>({...r,at:now-(now-r.at)*2}));
 expect(metricTrend(a,now,'tokens/s','request').slopePerMinute).toBe(1);
 expect(metricTrend(b,now,'tokens/s','request').slopePerMinute).toBe(.5);
 expect(metricTrend(a.map(r=>({...r,at:now})),now,'ms','request').slopePerMinute).toBeUndefined();
 const stale=metricTrend(a.map(r=>({...r,at:r.at-2*60*minute})),now,'ms','request');
 expect(stale.sufficient).toBe(false);expect(stale.ewma).toBeUndefined();expect(stale.current).toBe(14);
 expect(metricTrend([],now,'ms','request').current).toBeUndefined();
 const oneOutlier=metricTrend(Array.from({length:10},(_,i)=>({at:now-(9-i)*minute,value:i===9?100000:2000})),now,'ms','request');
 expect(oneOutlier.change.detected).toBe(false);
});
test('native decode excludes hidden reasoning and bursts and subtracts visible reasoning from answer tokens',()=>{
 expect(nativeDecode({out:200,ms:3000,ttft_ms:1000})).toBe(100);
 expect(nativeDecode({out:200,ms:1001,ttft_ms:1000})).toBeUndefined();
 expect(nativeDecode({out:200,ms:3000,ttft_ms:1000,flow_ms:100})).toBeUndefined();
 expect(nativeDecode({out:1200,reasoning:1000,ms:4000,ttft_ms:1000,first_text_ms:2000})).toBe(100);
 expect(nativeDecode({out:1200,reasoning:1000,ms:4000,ttft_ms:1000})).toBeUndefined();
 expect(nativeDecode({out:200,ms:4000,ttft_ms:1000,reasoning_hidden:true})).toBeUndefined();
});
test('raw requests preserve channel isolation, failed untimed requests and missing values without leaking account data',async()=>{
 const path=join(scratch(),'usage.jsonl');const at=new Date(now).toISOString();
 writeFileSync(path,[{t:at,provider:'p',model:'m',status:200,out:200,ms:3000,ttft_ms:1000,in:100,cache_read:300,host:'private@example.com',session:'secret'}, {t:at,provider:'p',model:'m',status:504}, {t:at,provider:'other',model:'m',status:200,ttft_ms:20000}, {t:at,provider:'p',model:'unknown',status:200}].map(r=>JSON.stringify(r)).join('\n')+'\npartial');
 const data=await readUsageSamples(now,path);expect(data.invalid).toBe(1);
 const rows=data.rows.get('p/m')!;expect(rows.errorRate?.map(r=>r.value)).toEqual([0,1]);expect(rows.ttftMs).toHaveLength(1);expect(rows.cacheHitRate?.[0]?.value).toBe(.75);expect(rows.tokensPerSecond?.[0]?.value).toBe(100);
 expect(data.rows.get('other/m')?.ttftMs?.[0]?.value).toBe(20000);expect(data.rows.get('p/unknown')?.ttftMs).toBeUndefined();
 expect(JSON.stringify([...data.rows])).not.toContain('private');expect(JSON.stringify([...data.rows])).not.toContain('secret');
});
test('gauges persist across restart and repeated identical reads never become extra evidence',async()=>{
 const file=join(scratch(),'gauges.json');const h=new GaugeHistory(file);
 await h.update({'p/m':{aaScore:50,remainingPct:90}},now-2*minute);
 await h.update({'p/m':{aaScore:50,remainingPct:90}},now-minute);
 const data=await new GaugeHistory(file).update({'p/m':{aaScore:50,remainingPct:80}},now);
 expect(data['p/m']?.aaScore).toHaveLength(1);expect(data['p/m']?.remainingPct).toHaveLength(2);
});
test('controller delivers all key trends and unit dictionary, one quality sample per finally accepted task',async()=>{
 const home=scratch(),log=join(home,'usage.jsonl');
 writeFileSync(log,Array.from({length:10},(_,i)=>JSON.stringify({t:new Date(now-(9-i)*minute).toISOString(),provider:'p',model:'m',status:200,out:200,ms:3000+i*100,ttft_ms:1000,in:100,cache_read:300})).join('\n')+'\n');
 const results=[{model:'p/m',domain:'general',overall:3,weight:.5,at:new Date(now-minute).toISOString(),task:'task:one'},{model:'p/m',domain:'general',overall:5,weight:.5,at:new Date(now).toISOString(),task:'task:one'}];
 const c=new ModelRoutingController({query:async()=>[results]} as any,home,'unused',{now:()=>now,usageLog:log,output:async()=> '[]',fetch:(async()=>Response.json({period:'7d',models:[]})) as unknown as typeof fetch});
 const facts=await c.rankingFacts(['p/m']);const f=facts[0]!;
 for(const key of ['ttftMs','tokensPerSecond','errorRate','cacheHitRate','performanceScore','aaScore','remainingPct'])expect(f.trends?.[key]).toBeDefined();
 expect(f.trends?.performanceScore?.baseline.samples).toBe(1);expect(f.trends?.performanceScore?.current).toBe(4);
 let payload:any;
 await jevOrder({model:'fixture',ask:async(state,q)=>{payload=state;return {model:'fixture',answers:Object.fromEntries(Object.keys(q).map(k=>[k,{type:'score',score:3}]))};}},'haiku','首token超过10秒排最后',facts);
 expect(payload.trendDictionary.slopePerMinute).toContain('最小二乘');expect(payload.models.m0.trends.ttftMs.samples).toBe(10);
 expect(JSON.stringify(payload)).not.toContain(home);
});

test('a missing or malformed log is explicit unknown rather than invented healthy measurements',async()=>{
 const dir=scratch(), file=join(dir,'usage.jsonl');
 await expect(readUsageSamples(now,file)).rejects.toThrow();
 writeFileSync(file,'null\n42\n[]\npartial\n');
 const data=await readUsageSamples(now,file);expect(data.invalid).toBe(4);expect(data.rows.size).toBe(0);
 const c=new ModelRoutingController({query:async()=>[[]]} as any,dir,'unused',{now:()=>now,usageLog:join(dir,'missing'),output:async()=> '[]',fetch:(async()=>Response.json({period:'7d',models:[]})) as unknown as typeof fetch});
 const f=(await c.rankingFacts(['p/m']))[0]!;expect(f.trendSource?.available).toBe(false);expect(f.trends?.ttftMs?.current).toBeUndefined();expect(f.trends?.errorRate?.current).toBeUndefined();
});

test('both owner surfaces share readable current, decay, slope, change and confidence units',async()=>{
 const {rankingTrendDetail}=await import('../plugin/shared/ranking-trends.ts');
 const t=metricTrend(Array.from({length:10},(_,i)=>({at:now-(9-i)*minute,value:i<5?.1:.8})),now,'ratio','request');
 const text=rankingTrendDetail(t);
 for(const word of ['当前','EWMA','斜率','百分点','突升','7天基线','10个请求','样本充分'])expect(text).toContain(word);
 expect(rankingTrendDetail()).toContain('未知');
});
