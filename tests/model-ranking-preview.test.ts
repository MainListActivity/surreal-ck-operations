import {rankingLayers} from "../plugin/shared/ranking-layers.ts";
import { rankingHealthMetric, rankingTrendDetail, rankingRuleLabel } from "../plugin/shared/ranking-trends.ts";
import {expect,test} from 'bun:test';
const page=await Bun.file(new URL('../plugin/client/company.tsx',import.meta.url)).text();
const source=page.slice(page.indexOf('function RankingJson('),page.indexOf('function RosterTab('));
const compiled=new Bun.Transpiler({loader:'tsx',tsconfig:{compilerOptions:{jsx:'react',jsxFactory:'React.createElement'}}}).transformSync(source+'\nreturn {ModelRankingCard,RankingJson,ModelIdentityCard,ModelRankingList,relayColors};');
function harness(data:any) {
 const elements:any[]=[];let states:any[]=[];let cursor=0;
 const React={createElement:(type:any,props:any,...children:any[]):any=>typeof type==='function'?type({...props,children}):{type,props:props??{},children}};
 const useState=(initial:any)=>{const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],(next:any)=>{states[i]=typeof next==='function'?next(states[i]):next;}];};
 const components=new Function('rankingLayers','rankingRuleLabel','rankingTrendDetail','rankingHealthMetric','React','useState','useEffect','useRpc','useQuery','makeStyles','rpc','Section','View','Text','TextInput','Pressable','ExpandableText','Collapsible',compiled)(
  rankingLayers,rankingRuleLabel,rankingTrendDetail,rankingHealthMetric,React,useState,()=>{},()=>()=>{},()=>({data,isError:false}),()=>({}),{},'Section','View','Text','TextInput','Pressable',({text}:any)=>React.createElement('Text',{},text),'Collapsible');
 const render=(name:string,props:any)=>{cursor=0;elements.length=0;const root=components[name]({...props,ctx:{theme:{colors:{surface0:"#ffffff"}},compact:false,...props.ctx}});const walk=(node:any)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}elements.push(node);node.children?.forEach(walk);};walk(root);return elements;};
 const text=()=>elements.filter(n=>n.type==='Text').map(n=>n.children.flat(Infinity).filter((v:any)=>typeof v==='string'||typeof v==='number').join('')).join('\n');
 return {render,text,colors:(ctx:any)=>components.relayColors(ctx)};
}
test('ranking UI shows default rules and an honest empty state before the first recorded attempt',()=>{
 const h=harness({rules:'智能程度和速度综合优先',refreshMinutes:5,configured:true,orders:{},requests:[]});
 const nodes=h.render('ModelRankingCard',{ctx:{}});
 expect(nodes.some(n=>n.type==='TextInput'&&n.props.accessibilityLabel==='模型排序规则')).toBe(false);
 expect(nodes.filter(n=>n.type==='TextInput')).toHaveLength(7);
 expect(h.text()).toContain('智能程度和速度综合优先');
 expect(h.text()).toContain('没有历史请求');
});
test('ranking UI exposes each request timestamp and exact JSON, and JSON sections expand on press',()=>{
 const payload={model:'jev-fixture',state:{ownerRules:'旧规则',models:{m0:{id:'p/a'}}},questions:{m0:{instructions:'排序问题'}}};
 const h=harness({rules:'新规则',refreshMinutes:5,configured:true,orders:{},requests:[{tier:'opus',at:'2026-10-24T02:45:13Z',payload}]});
 h.render('ModelRankingCard',{ctx:{}});
 expect(h.text()).toContain('OPUS');expect(h.text()).toContain('调用开始');
 expect(h.text()).toContain(JSON.stringify(payload,null,2));expect(h.text()).not.toContain('没有历史请求');
 const tree=harness(undefined);
 let nodes=tree.render('RankingJson',{ctx:{},label:'state',value:payload.state});
 expect(tree.text()).toContain('旧规则');expect(tree.text()).not.toContain('p/a');
 nodes.find(n=>n.type==='Pressable'&&n.props.accessibilityState?.expanded===false).props.onPress();
 nodes=tree.render('RankingJson',{ctx:{},label:'state',value:payload.state});
 // Models are now open, each nested model retains its own expand control.
 expect(nodes.filter(n=>n.type==='Pressable'&&n.props.accessibilityState?.expanded===true)).toHaveLength(2);
});

test('identity UI separates grouped/history from pending and hides completed decisions by default',()=>{
 const data={issues:[],aliases:[
  {model:'p/matched',slug:'matched',by:'jev'},
  {model:'p/rejected',slug:null,by:'jev',confidence:1},
  {model:'p/uncertain',slug:null,by:'jev',suggested:'candidate',confidence:0.5},
  {model:'p/grouped',slug:null,by:'jev',suggested:'candidate',confidence:0.5},
 ],inventory:{at:'now',grouped:[{model:'p/grouped',groups:['sck-haiku']}],decidedUngrouped:[{model:'p/rejected',by:'jev',reason:'无对应',present:true}],pending:['p/new']}};
 const h=harness(data);let nodes=h.render('ModelIdentityCard',{ctx:{}});
 expect(h.text()).toContain('待裁决 / 待人工确认（2）');
 expect(nodes.filter(n=>n.type==='TextInput').map(n=>n.props.accessibilityLabel)).toEqual(['p/uncertain 对应的 AA slug','p/new 对应的 AA slug']);
 expect(nodes.find(n=>n.type==='Collapsible'&&n.props.title==='已入组（1）')).toBeDefined();
 const history=nodes.find(n=>n.type==='Pressable'&&n.children.some((c:any)=>c?.children?.some((t:any)=>typeof t==='string'&&t.includes('查看历史裁决'))));
 history.props.onPress();nodes=h.render('ModelIdentityCard',{ctx:{}});
 expect(nodes.filter(n=>n.type==='TextInput')).toHaveLength(5);
});

const rankingCtx={compact:true,theme:{colors:{accent:'#2563eb',border:'#ddd'}}};
test('compact model rows expand on demand and preserve real scores, zero quotas and unknowns',()=>{
 const h=harness(undefined),props={ctx:rankingCtx,table:{group:'sck-haiku',at:'2026-10-24T08:06:10Z',rules:'智能程度和速度综合优先',scored:true,rows:[
  {model:'remote-magpie/codearts/deepseek:max',jevScore:3.712345,aaScore:45.1,aaRank:30,effort:'max',tokensPerSecond:164,ttftMs:15205,accounts:[{account:'p #1',remainingPct:0}],performanceScore:4.72,performanceSamples:2.5,stabilityPct:99.8,stabilitySamples:5900},
  {model:'p/zero',jevScore:0,tokensPerSecond:0,accounts:[]},
  {model:'p/new',accounts:[]},
 ]}};
 let nodes=h.render('ModelRankingList',props);
 expect(h.text()).toContain('待测');expect(h.text()).not.toContain('3.7123');expect(h.text()).not.toContain('15.21 秒');
 nodes.find(n=>n.props.accessibilityLabel==='第 1 名 remote-magpie/codearts/deepseek:max').props.onPress();
 h.render('ModelRankingList',props);
 for(const value of ['45.1','164 tok/s','15.21 秒','0.0%','4.72 / 5','99.8%','2.50'])expect(h.text()).toContain(value);
 nodes=h.render('ModelRankingList',props);nodes.find(n=>n.props.accessibilityLabel==='第 2 名 p/zero').props.onPress();h.render('ModelRankingList',props);
 expect(h.text()).toContain('0 tok/s');expect(h.text()).not.toContain('15.21 秒');expect(h.text()).toContain('待测');
 h.render('ModelRankingList',{ctx:rankingCtx,table:{group:'sck-haiku',scored:false,rows:[{model:'p/old',accounts:[]}]}});
 expect(h.text()).toContain('待测');expect(h.text()).toContain('等待下一次请求');
});
test('ranking group selector defaults to Haiku and switches lists without showing another group scores',()=>{
 const data={rules:'默认规则',refreshMinutes:5,configured:true,orders:{},requests:[],tables:[
  {group:'sck-opus',scored:true,rows:[{model:'p/opus',jevScore:4,accounts:[]}]},
  {group:'sck-haiku',scored:true,rows:[{model:'p/haiku',jevScore:2,accounts:[]}]},
 ]};
 const h=harness(data);let nodes=h.render('ModelRankingCard',{ctx:rankingCtx});expect(h.text()).toContain('Opus 的成员、顺序和组内配置由你在 Magpie 手动维护');expect(nodes.some(n=>n.props.accessibilityLabel==='第 1 名 p/haiku')).toBe(true);expect(nodes.some(n=>n.props.accessibilityLabel==='第 1 名 p/opus')).toBe(false);
 nodes.find(n=>n.props.accessibilityLabel==='查看 sck-opus 模型排序').props.onPress();
 nodes=h.render('ModelRankingCard',{ctx:rankingCtx});expect(nodes.some(n=>n.props.accessibilityLabel==='第 1 名 p/opus')).toBe(true);expect(nodes.some(n=>n.props.accessibilityLabel==='第 1 名 p/haiku')).toBe(false);
});

test('Figma palette follows Paseo light/dark appearance including RGB surfaces',()=>{
 const h=harness(undefined);
 const light=h.colors({theme:{colors:{surface0:'#fafafa'}}}),dark=h.colors({theme:{colors:{surface0:'#0b0d10'}}});
 expect(light.surface1).toBe('#ffffff');expect(dark.surface1).toBe('#17181d');expect(light.foreground).not.toBe(dark.foreground);
 expect(h.colors({theme:{colors:{surface0:'rgb(12, 14, 18)'}}}).surface1).toBe(dark.surface1);
 expect(h.colors({theme:{colors:{surface0:'hsl(240 6% 7%)'}}}).surface1).toBe(dark.surface1);
});

test('ranking row has an independent pin action and clearly labels a pinned model',async()=>{
 const h=harness(undefined),calls:unknown[]=[];
 const nodes=h.render('ModelRankingList',{ctx:rankingCtx,table:{group:'sck-haiku',scored:true,rows:[{model:'p/a:max',pinned:true,accounts:[]}]},onPin:async(...args:unknown[])=>{calls.push(args);}});
 expect(h.text()).toContain('置顶');
 const button=nodes.find(n=>n.props.accessibilityLabel==='取消置顶 p/a:max');expect(button).toBeDefined();await button.props.onPress();expect(calls).toEqual([['p/a:max',false]]);
});

test('mobile expanded model cards expose trend explanations and freshness',()=>{
 const h=harness(undefined);
 const trend={unit:'ms',sampleUnit:'request',current:12000,ewma:11000,slopePerMinute:6000,samples:10,sufficient:true,ageMs:60000,change:{detected:true,direction:'up'},baseline:{samples:5000,mean:2000},windows:{}};
 const props={ctx:{...rankingCtx,compact:true},width:390,table:{group:'sck-haiku',scored:true,rows:[{model:'p/mobile',accounts:[],trends:{ttftMs:trend}}]}};
 const nodes=h.render('ModelRankingList',props);nodes.find(n=>n.props.accessibilityLabel==='第 1 名 p/mobile').props.onPress();
 h.render('ModelRankingList',props);
 for(const word of ['EWMA','斜率','突升','7天基线','10个请求','距最新样本1分钟'])expect(h.text()).toContain(word);
});
test('ranking list visibly separates billing layers and explains why the lower score stays first',()=>{
 const decision={band:0,coldStart:false,latencySource:'unknown',billing:'subscription',quota:'available',reason:'fixed'};
 const h=harness(undefined);const nodes=h.render('ModelRankingList',{ctx:rankingCtx,table:{group:'sck-haiku',scored:true,bandWidth:2,bandRanges:{'["",0]':{top:45.1,bottom:43.1}},rows:[
  {model:'p/free',accounts:[],aaScore:43.7,decision:{...decision,score:16.2,costClass:'free'}},
  {model:'p/included',accounts:[],aaScore:43.7,decision:{...decision,score:52.4,costClass:'included'}},
 ]}});
 expect(nodes.filter(n=>n.props.accessibilityLabel?.startsWith('第')&&n.props.accessibilityLabel.includes('层')).map(n=>n.props.accessibilityLabel)).toEqual(['第1层 · 正常可用 · 常规候选 · 能力档1 · 免费','第2层 · 正常可用 · 常规候选 · 能力档1 · 套餐/积分覆盖']);
 expect(h.text()).toContain('AA 43.1–45.1');expect(h.text()).toContain('跨层不比较分数');expect(h.text()).toContain('层内分');
 expect(nodes.filter(n=>n.props.accessibilityLabel?.startsWith('第 ')&&n.props.accessibilityLabel.includes('名')).map(n=>n.props.accessibilityLabel)).toEqual(['第 1 名 p/free','第 2 名 p/included']);
});
