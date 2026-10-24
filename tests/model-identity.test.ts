import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bundled from '../src/model-routing/benchmarks.json';
import {classify,effortOfName,resolveBenchmark,splitMember,useAliases,useBenchmarks,canonicalModel,type BenchmarkRow} from '../src/model-routing/policy.ts';
import {parseAaLeaderboard} from '../src/model-routing/aa.ts';
import {askAlias,aliasCandidates} from '../src/model-routing/alias.ts';
import {ModelRoutingController,memberIssue,GROUPING_VERSION} from '../src/model-routing/controller.ts';
import {modelFacts} from '../src/model-routing/ranking.ts';

const dirs:string[]=[];
const scratch=()=>{const p=mkdtempSync(join(tmpdir(),'sck-identity-'));dirs.push(p);return p;};
afterEach(()=>{useBenchmarks(bundled.models);useAliases({});for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
// Shaped like the live leaderboard: the slug often omits the level the name carries.
const ROWS:BenchmarkRow[]=[
 {slug:'claude-sonnet-5-5',name:'Claude Sonnet 5.5 (Max, Default Fallback)',score:56},
 {slug:'claude-sonnet-5-5-medium',name:'Claude Sonnet 5.5 (Medium)',score:40.8},
 {slug:'deepseek-v4-1-flash-1017',name:'DeepSeek V4.1 Flash 1017 (Max)',score:45.1},
 {slug:'gpt-6-luna',name:'GPT-6 Luna (Max)',score:38.1},
 {slug:'gpt-6-luna-xhigh',name:'GPT-6 Luna (Xhigh)',score:34.6},
 {slug:'gpt-6-luna-non-reasoning',name:'GPT-6 Luna (Non-reasoning)',score:18.5},
 {slug:'gpt-6-1-sol',name:'GPT-6.1 Sol (Max)',score:51.8},
 {slug:'gpt-6-1-sol-medium',name:'GPT-6.1 Sol (Medium)',score:47.8},
 {slug:'glm-5-3-flash',name:'GLM-5.3-Flash',score:41.8},
 {slug:'glm-5-3',name:'GLM-5.3 (Max)',score:44.8},
 {slug:'grok-4-7',name:'Grok 4.7 (Xhigh)',score:46.4},
 {slug:'qwen3-8-flash-next',name:'Qwen3.8-Flash-Next',score:39.8},
];
const ALL=['low','medium','high','xhigh','max'];

test('AA names carry the measured level; members carry the level they are sent at',()=>{
 expect(effortOfName('Claude Sonnet 5.5 (Max, Default Fallback)')).toBe('max');
 expect(effortOfName('GPT-6 Luna (Non-reasoning)')).toBe('none');
 expect(effortOfName('Qwen3.8-Flash-Next')).toBeUndefined();
 expect(effortOfName('Qwen3.8 Max (0902)')).toBeUndefined();
 expect(splitMember('codex/gpt-6-luna:max')).toEqual({id:'codex/gpt-6-luna',effort:'max',fast:false});
 expect(splitMember('codex/gpt-6.1-sol:high:fast')).toEqual({id:'codex/gpt-6.1-sol',effort:'high',fast:true});
 expect(splitMember('openrouter/x:free')).toEqual({id:'openrouter/x:free',fast:false});
 expect(canonicalModel('codex/gpt-6-luna:max')).toBe(canonicalModel('workbuddy-ai/gpt-6-luna'));
 const rows=parseAaLeaderboard(`<script>self.__next_f.push(${JSON.stringify([1,`{"initialModels":${JSON.stringify([{slug:'gpt-6-luna',name:'GPT-6 Luna (Max)',intelligenceIndex:38.1}])}}`])})</script>`);
 expect(rows[0]).toMatchObject({slug:'gpt-6-luna',name:'GPT-6 Luna (Max)',score:38.1});
});

test('a band admitted on a level is served at that level; a level magpie cannot send is not claimed',()=>{
 useBenchmarks(ROWS);
 expect(resolveBenchmark('codex/gpt-6-luna',ALL)).toMatchObject({row:{slug:'gpt-6-luna'},effort:'max'});
 // The vendor fixes the level in its id: matched by AA's name, nothing to pin.
 expect(resolveBenchmark('trae-global/gpt-6-luna-max',[])).toEqual({row:ROWS[3]!});
 expect(resolveBenchmark('workbuddy-ai/gpt-6-luna:xhigh',ALL)?.row.score).toBe(34.6);
 expect(resolveBenchmark('trae-cn/deepseek-v4.1-flash',['low','high','xhigh'])).toBeUndefined();
 expect(resolveBenchmark('claude/claude-sonnet-5-5',['medium'])).toMatchObject({row:{score:40.8},effort:'medium'});
 expect(resolveBenchmark('grok/grok-4.7:medium',ALL)).toBeUndefined();
 expect(resolveBenchmark('auto/zai_glm-5.3-flash',ALL)?.row.slug).toBe('glm-5-3-flash');
 expect(resolveBenchmark('grok/grok-4.7@500k',ALL)).toMatchObject({row:{slug:'grok-4-7'},effort:'xhigh'});
 expect(resolveBenchmark('joycode/GLM-5.3-agent',ALL)).toBeUndefined();
 useAliases({'joycode/GLM-5.3-agent':'glm-5-3','trae-cn/qwen3.8-flash':null});
 expect(resolveBenchmark('joycode/GLM-5.3-agent',ALL)).toMatchObject({row:{slug:'glm-5-3'},effort:'max'});
 expect(resolveBenchmark('trae-cn/qwen3.8-flash',ALL)).toBeUndefined();
 const c=classify([{id:'codex/gpt-6-luna',reasoning_levels:ALL},{id:'w/gpt-6-luna',reasoning_levels:['xhigh']},{id:'p/deepseek-v4.1-flash',reasoning_levels:['low','high','max']}]);
 expect(c.map(m=>[m.member,m.tier])).toEqual([['p/deepseek-v4.1-flash:max','sonnet'],['codex/gpt-6-luna:max','sonnet']]);
 // Jev sees the score of the level actually sent.
 expect(modelFacts(['w/gpt-6-luna:xhigh'],{catalog:[{id:'w/gpt-6-luna',reasoning_levels:ALL}],quota:new Map(),usage:new Map(),performance:new Map()})[0]?.aa).toMatchObject({score:34.6,effort:'xhigh'});
});

test('member issues: below the floor, wrong band, or no score at the pinned level',()=>{
 useBenchmarks(ROWS);
 expect(memberIssue('haiku','w/gpt-6-luna:xhigh',ALL)).toContain('低于 38');
 expect(memberIssue('opus','p/deepseek-v4.1-flash:max',ALL)).toContain('sonnet');
 expect(memberIssue('opus','claude/claude-sonnet-5-5:medium',ALL)).toContain('sonnet');
 expect(memberIssue('opus','codex/gpt-6.1-sol:medium',ALL)).toBeUndefined();
 expect(memberIssue('fable','codex/gpt-6.1-sol:max',ALL)).toBeUndefined();
 expect(memberIssue('opus','grok/grok-4.7:medium',ALL)).toContain('没有该思考等级');
});

test('Jev names a vendor model once: confident picks are adopted, unsure ones only suggested',async()=>{
 useBenchmarks(ROWS);
 expect(aliasCandidates('joycode/GLM-5.3-agent').slice(0,2).map(r=>r.slug).sort()).toEqual(['glm-5-3','glm-5-3-flash']);
 const jev=(choice:string,confidence:number)=>({model:'f',ask:async(_s:unknown,q:any)=>{const opts=q.same.criteria;const key=Object.keys(opts).find(k=>String(opts[k]).includes(choice))??'none';return {model:'f',answers:{same:{type:'choice' as const,choice:key,confidence}}};}});
 expect(await askAlias(jev('slug glm-5-3）',0.9),{id:'joycode/GLM-5.3-agent'})).toMatchObject({slug:'glm-5-3',by:'jev'});
 expect(await askAlias(jev('slug glm-5-3）',0.5),{id:'joycode/GLM-5.3-agent'})).toMatchObject({slug:null,suggested:'glm-5-3'});
 expect(await askAlias(jev('都不是',0.99),{id:'joycode/GLM-5.3-agent'})).toMatchObject({slug:null});
});

function controller(home:string,catalog:any[],store:Record<string,string[]>,jevAnswers:Record<string,string|null>={}){
 let asks=0;
 const db={query:async(sql:string)=>sql.includes('SELECT enabled')?[{enabled:true}]:sql.includes('SELECT orders')||sql.includes('SELECT issues')?[{}]:[[]]};
 const io={fetch:(async()=>Response.json({data:catalog})) as unknown as typeof fetch,groups:()=>store,
  command:async(args:string[])=>{if(args[1]==='add')store[args[2]!]=args[3]!.slice(7).split(',');},
  jev:{model:'f',ask:async(state:any,q:any)=>{asks++;const want=jevAnswers[state.model];const opts=q.same.criteria;const key=want?Object.keys(opts).find(k=>String(opts[k]).includes(`slug ${want}）`)):'none';return {model:'f',answers:{same:{type:'choice' as const,choice:key??'none',confidence:0.95}}};}}};
 const c=new ModelRoutingController(db as any,home,'unused',io);
 const aa=join(home,'model-routing');mkdirSync(aa,{recursive:true});
 writeFileSync(join(aa,'aa.json'),JSON.stringify({source:'x',retrievedAt:new Date().toISOString(),models:ROWS}));
 return {c,io,asks:()=>asks};
}
test('sync pins bare members, keeps owner levels, asks Jev once per unnamed model and places it',async()=>{
 const home=scratch();
 const catalog=[
  {id:'p/gpt-6.1-sol',reasoning_levels:ALL},{id:'p/deepseek-v4.1-flash',reasoning_levels:['low','high','max']},
  {id:'p/gpt-6-luna',reasoning_levels:ALL},{id:'j/GLM-5.3-agent',reasoning_levels:ALL},{id:'t/mystery-1',reasoning_levels:ALL},
 ];
 const store:Record<string,string[]>={};
 const first=controller(home,catalog,store,{'j/GLM-5.3-agent':'glm-5-3'});
 await first.c.refresh(true);
 expect(store['sck-opus']).toBeUndefined();
 expect(store['sck-haiku']!.sort()).toEqual(['j/GLM-5.3-agent:max','p/deepseek-v4.1-flash:max','p/gpt-6-luna:max'].sort());
 expect(first.asks()).toBe(2);
 const aliases=JSON.parse(readFileSync(join(home,'model-routing','aliases.json'),'utf8'));
 expect(aliases['j/GLM-5.3-agent']).toMatchObject({slug:'glm-5-3',by:'jev'});
 expect(aliases['t/mystery-1']).toMatchObject({slug:null});
 // The owner pins a member to a level of their own and lists one bare: the first stays, the second is pinned.
 store['sck-haiku']=['p/gpt-6-luna:xhigh','p/deepseek-v4.1-flash'];
 const second=controller(home,catalog,store);
 await second.c.refresh(true);
 expect(second.asks()).toBe(0);
 expect(store['sck-haiku']).toContain('p/gpt-6-luna:xhigh');
 expect(store['sck-haiku']).toContain('p/deepseek-v4.1-flash:max');
 expect(store['sck-haiku']).not.toContain('j/GLM-5.3-agent:max'); // removed by hand, stays removed
 const identity=await second.c.identity();
 expect(identity.aliases[0]).toMatchObject({model:'j/GLM-5.3-agent',slug:'glm-5-3',aa:{name:'GLM-5.3 (Max)',score:44.8}});
 // The owner names the mystery model; it is not in any group yet, so the next sync places it.
 await expect(second.c.setAlias('t/mystery-1','no-such-model')).rejects.toThrow();
 await second.c.setAlias('t/mystery-1','qwen3-8-flash-next');
 expect(store['sck-haiku']).toContain('t/mystery-1');
});

const baseCatalog=()=>[{id:'p/gpt-6.1-sol',reasoning_levels:ALL},{id:'p/deepseek-v4.1-flash',reasoning_levels:ALL}];
const readInventory=(home:string)=>JSON.parse(readFileSync(join(home,'model-routing','inventory.json'),'utf8'));
test('first full scan processes every unjudged id across bounded batches; restart and grouping version never repeat decisions',async()=>{
 const home=scratch();const catalog=[...baseCatalog(),...Array.from({length:8},(_,i)=>({id:`vendor/opaque-${i}`}))];
 const groups:Record<string,string[]>={};const first=controller(home,catalog,groups);
 await first.c.refresh(true);expect(first.asks()).toBe(6);
 let view=(await first.c.identity()).inventory;expect(view.pending).toHaveLength(2);expect(view.decidedUngrouped.filter(m=>m.by==='jev')).toHaveLength(6);
 const second=controller(home,catalog,groups);await second.c.refresh(true);expect(second.asks()).toBe(2);
 view=(await second.c.identity()).inventory;expect(view.pending).toEqual([]);expect(view.decidedUngrouped.filter(m=>m.by==='jev')).toHaveLength(8);
 writeFileSync(join(home,'model-routing','membership.json'),JSON.stringify({version:'old-version',known:[]}));
 const third=controller(home,catalog,groups);await third.c.refresh(true);expect(third.asks()).toBe(0);
 catalog.push({id:'vendor/new-model'} as any);await third.c.refresh(true);expect(third.asks()).toBe(1);
 await third.c.refresh(true);expect(third.asks()).toBe(1);
});
test('already grouped opaque models and migrated historical decisions never become new questions',async()=>{
 const home=scratch();const store={'sck-haiku':['vendor/grouped-model']};
 const f=controller(home,[...baseCatalog(),{id:'vendor/grouped-model'},{id:'vendor/rejected-model'}],store);
 writeFileSync(join(home,'model-routing','membership.json'),JSON.stringify({version:GROUPING_VERSION,known:[]}));
 writeFileSync(join(home,'model-routing','aliases.json'),JSON.stringify({'vendor/rejected-model':{slug:null,by:'jev',confidence:1,at:'2026-10-23T00:00:00Z'}}));
 await f.c.refresh(true);expect(f.asks()).toBe(0);
 let view=(await f.c.identity()).inventory;expect(view.grouped.find(m=>m.model==='vendor/grouped-model')?.groups).toContain('sck-haiku');
 store['sck-haiku']=store['sck-haiku'].filter(m=>m!=='vendor/grouped-model');
 const restarted=controller(home,[...baseCatalog(),{id:'vendor/grouped-model'},{id:'vendor/rejected-model'}],store);
 await restarted.c.refresh(true);expect(restarted.asks()).toBe(0);
 view=(await restarted.c.identity()).inventory;expect(view.decidedUngrouped.some(m=>m.model==='vendor/grouped-model')).toBe(true);
});
test('completed answers survive a later call failure and loss of the compatibility alias file',async()=>{
 const home=scratch();const catalog=[...baseCatalog(),{id:'vendor/one'},{id:'vendor/two'}];const groups:Record<string,string[]>={};
 const f=controller(home,catalog,groups);const original=f.io.jev.ask;let n=0;
 f.io.jev.ask=async(state,q)=>{if(++n===2)throw Error('fixture network failure');return original(state,q);};
 await expect(f.c.refresh(true)).rejects.toThrow('fixture network failure');
 expect(readInventory(home).decisions['vendor/one']).toMatchObject({by:'jev',slug:null});
 rmSync(join(home,'model-routing','aliases.json'));
 const restarted=controller(home,catalog,groups);await restarted.c.refresh(true);expect(restarted.asks()).toBe(1);
 expect((await restarted.c.identity()).inventory.pending).toEqual([]);
});
test('manual decision waits for in-flight discovery, persists, and suppresses future Jev calls',async()=>{
 const home=scratch();const catalog=[...baseCatalog(),{id:'vendor/opaque'}];const groups:Record<string,string[]>={};
 const f=controller(home,catalog,groups);const original=f.io.jev.ask;let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 f.io.jev.ask=async(state,q)=>{entered();await gate;return original(state,q);};
 const refresh=f.c.refresh(true);await started;
 const manual=f.c.setAlias('vendor/opaque','glm-5-3');release();await Promise.all([refresh,manual]);
 expect(readInventory(home).decisions['vendor/opaque']).toMatchObject({by:'owner',slug:'glm-5-3'});
 expect(groups['sck-haiku']).toContain('vendor/opaque');
 const restarted=controller(home,catalog,groups);await restarted.c.refresh(true);expect(restarted.asks()).toBe(0);
});
test('malformed Jev answers are not cached as completed negative decisions',async()=>{
 useBenchmarks(ROWS);
 await expect(askAlias({model:'f',ask:async()=>({model:'f',answers:{}})},{id:'vendor/opaque'})).rejects.toThrow();
});

test('below-floor or unavailable reasoning levels are recorded once without a paid identity question',async()=>{
 const home=scratch();const f=controller(home,[...baseCatalog(),{id:'w/gpt-6-luna',reasoning_levels:['xhigh']},{id:'t/deepseek-v4.1-flash',reasoning_levels:['high']}],{});
 await f.c.refresh(true);expect(f.asks()).toBe(0);
 const view=(await f.c.identity()).inventory;
 expect(view.decidedUngrouped.find(m=>m.model==='w/gpt-6-luna')?.reason).toContain('低于 38');
 expect(view.decidedUngrouped.find(m=>m.model==='t/deepseek-v4.1-flash')?.reason).toContain('没有 AA 已测等级');
 await f.c.refresh(true);expect(f.asks()).toBe(0);
});
test('corrupt decision inventory fails closed instead of re-questioning all models',async()=>{
 const home=scratch();const f=controller(home,[...baseCatalog(),{id:'vendor/opaque'}],{});
 writeFileSync(join(home,'model-routing','inventory.json'),'{broken');
 await expect(f.c.refresh(true)).rejects.toThrow();expect(f.asks()).toBe(0);
});

test('manual save reports successful persistence even when the following group sync is unavailable',async()=>{
 const home=scratch();const f=controller(home,[...baseCatalog(),{id:'vendor/opaque'}],{});await f.c.refresh(true);
 f.io.fetch=(async()=>{throw Error('fixture offline');}) as unknown as typeof fetch;
 expect(await f.c.setAlias('vendor/opaque','glm-5-3')).toEqual({synchronized:false});
 expect(readInventory(home).decisions['vendor/opaque']).toMatchObject({by:'owner',slug:'glm-5-3'});
 const restarted=controller(home,[...baseCatalog(),{id:'vendor/opaque'}],{});await restarted.c.refresh(true);expect(restarted.asks()).toBe(0);
});

test('a failed in-flight background sync cannot reject a queued manual confirmation before saving',async()=>{
 const home=scratch();const f=controller(home,[...baseCatalog(),{id:'vendor/opaque'}],{});
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 f.io.jev.ask=async()=>{entered();await gate;throw Error('fixture unavailable');};
 const refresh=f.c.refresh(true);await started;
 const manual=f.c.setAlias('vendor/opaque','glm-5-3');
 const failed=refresh.catch(error=>error);release();
 expect((await failed).message).toBe('fixture unavailable');
 expect(await manual).toEqual({synchronized:true});
 expect(readInventory(home).decisions['vendor/opaque']).toMatchObject({by:'owner',slug:'glm-5-3'});
});
test('inherited property names are not valid Jev answer choices',async()=>{
 useBenchmarks(ROWS);
 for(const choice of ['constructor','toString','__proto__']){
  await expect(askAlias({model:'f',ask:async()=>({model:'f',answers:{same:{type:'choice',choice,confidence:1}}})},{id:'vendor/opaque'})).rejects.toThrow();
 }
});
