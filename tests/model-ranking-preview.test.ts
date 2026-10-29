import {expect,test} from 'bun:test';
import {relayPalette} from '../plugin/client/relay-theme.ts';
import {rankingTrendDetail} from '../plugin/shared/ranking-trends.ts';
import {ROUTING_WEIGHTS,ROUTING_DEFAULTS,ROUTING_FORMULA,ROUTING_COST_HELP,routingMetrics,routingNumber,routingTrends,routingCalculation} from '../plugin/shared/model-routing-view.ts';
const page=await Bun.file(new URL('../plugin/client/model-routing.tsx',import.meta.url)).text();
const source=page.slice(page.indexOf('const GROUPS')).replace('export function ModelRoutingPanel','function ModelRoutingPanel');
const compiled=new Bun.Transpiler({loader:'tsx',tsconfig:{compilerOptions:{jsx:'react',jsxFactory:'React.createElement'}}}).transformSync(source+'\nreturn ModelRoutingPanel;');
function harness(ranking:any={tables:[],policy:ROUTING_DEFAULTS},catalog:any={models:[],total:0,nextOffset:null,benchmarks:[]}){
 let cursor=0;const states:any[]=[],elements:any[]=[],writes:any[]=[];
 const React={createElement:(type:any,props:any,...children:any[]):any=>typeof type==='function'?type({...props,children}):({type,props:props??{},children})};
 const useState=(initial:any)=>{const key=cursor++;if(!(key in states))states[key]=initial;return [states[key],(next:any)=>{states[key]=typeof next==='function'?next(states[key]):next;}];};
 const rpc={modelRanking:'get',previewModelRanking:'preview',saveModelRanking:'save',pinModelRanking:'pin',modelCatalog:'catalog',setModelMembership:'membership',setModelAlias:'alias'};
 const component=new Function('React','useState','useEffect','useRpc','useQuery','useQueryClient','rpc','relayPalette','ROUTING_WEIGHTS','ROUTING_DEFAULTS','ROUTING_FORMULA','ROUTING_COST_HELP','routingMetrics','routingNumber','routingTrends','routingCalculation','rankingTrendDetail','View','Text','TextInput','Pressable',compiled)(React,useState,()=>{},(tool:string)=>async(input:unknown)=>{writes.push([tool,input]);return {};},(options:any)=>({data:options.queryKey[0]==='model-catalog'?catalog:ranking,isError:false,refetch:async()=>{}}),()=>({invalidateQueries:async()=>{}}),rpc,relayPalette,ROUTING_WEIGHTS,ROUTING_DEFAULTS,ROUTING_FORMULA,ROUTING_COST_HELP,routingMetrics,routingNumber,routingTrends,routingCalculation,rankingTrendDetail,'View','Text','TextInput','Pressable');
 const render=(compact=false)=>{cursor=0;elements.length=0;const root=component({ctx:{theme:{colors:{surface0:'#ffffff'}},compact}});const walk=(node:any)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}elements.push(node);node.children?.forEach(walk);};walk(root);return elements;};
 const texts=(node:any):string=>Array.isArray(node)?node.map(texts).join(''):typeof node==='string'||typeof node==='number'?String(node):node?.children?texts(node.children):'';
 return {render,writes,text:()=>elements.filter(n=>n.type==='Text').map(texts).join('\n'),button:(title:string)=>elements.find(n=>n.type==='Pressable'&&texts(n)===title),elements};
}
const row={model:'vendor/model:max',aaScore:50,accounts:[{account:'masked',remainingPct:0}],ttftMs:30000,decision:{score:42.36,reason:'非线性总分 42.36',latencySource:'historical-average',billing:'subscription',quota:'low',costClass:'free',contributions:{price:{value:1,weight:5,factor:1,points:0}},factors:{base:80,latency:0.5,availability:1,reliability:1,urgency:1,exploration:2.36,estimatedCost:0}}};
test('ranking surface replaces old layers/Jev widgets with six weights, global score and catalog actions',()=>{
 const h=harness();const nodes=h.render();expect(nodes.filter(n=>n.type==='TextInput')).toHaveLength(7);
 expect(h.text()).toContain('几何效用');expect(h.text()).toContain('本组暂无匹配成员');
 expect(h.text()).not.toContain('历史 JEV');expect(h.text()).not.toContain('AA 能力档宽度');
 expect(h.button('管理模型')).toBeDefined();expect(h.button('保存设置')).toBeDefined();
});
test('compact rows expand to real score factors, free quota immunity, prices and trend explanations',()=>{
 const h=harness({tables:[{group:'sck-haiku',scored:true,rows:[row]}]});let nodes=h.render(true);
 expect(h.text()).toContain('42.4');expect(h.text()).not.toContain('供应商额度');
 nodes.find(n=>n.type==='Pressable'&&n.props.accessibilityState?.expanded===false).props.onPress();h.render(true);
 expect(h.text()).toContain('费用原始分');expect(h.text()).toContain('免费，不扣分');expect(h.text()).toContain('原始分 100.0 / 100');
 expect(h.text()).toContain('乘数 1.000');expect(h.text()).toContain('首 token 趋势');expect(h.text()).toContain('42.36');
 for(const name of ['输出速度趋势','错误率趋势','缓存命中趋势','额度趋势','绩效趋势','AA 能力趋势','缓存命中率','请求成功率'])expect(h.text()).toContain(name);
 expect(h.button('置顶模型')).toBeDefined();
});
test('manual groups remain navigable without fabricated scores or pin actions',()=>{
 const h=harness({tables:[{group:'sck-haiku',rows:[row]},{group:'sck-opus',rows:[{model:'manual/opus',accounts:[]}]}]});
 h.render();const opus=h.elements.find(n=>n.props.accessibilityRole==='tab'&&n.children.flat(Infinity).some((v:any)=>v?.children?.[0]==='Opus'));
 expect(opus).toBeDefined();opus.props.onPress();h.render();expect(h.text()).toContain('本组按你维护的顺序');expect(h.text()).not.toContain('42.4');
});
test('catalog provides scored AA choices and exact CAS membership changes from the same screen',async()=>{
 const model={id:'v/new',name:'New Model',levels:['max'],groups:[],members:{'sck-haiku':[]},slug:null,status:'pending'};
 const h=harness({tables:[]},{models:[model],total:1,nextOffset:null,benchmarks:[{slug:'aa-model',name:'Known AA',score:55}]});
 h.render();h.button('管理模型').props.onPress();h.render();
 h.elements.find(n=>n.type==='Pressable'&&n.props.accessibilityState?.expanded===false).props.onPress();h.render();
 expect(h.text()).toContain('Known AA · 55.0');expect(h.text()).toContain('添加到 Haiku');
 await h.button('添加到 Haiku').props.onPress();await new Promise(r=>setTimeout(r,0));
 expect(h.writes).toContainEqual(['membership',{group:'sck-haiku',model:'v/new:max',present:true,expectedMembers:[]}]);
});

test('Paseo removes the interval selector and saves only the policy',async()=>{const h=harness();h.render();expect(h.text()).not.toContain('刷新间隔');expect(h.button('10 分钟')).toBeUndefined();h.elements.find(n=>n.type==='TextInput'&&n.props.accessibilityLabel==='首 token 延迟权重').props.onChangeText('90');h.render();await h.button('保存设置').props.onPress();await new Promise(r=>setTimeout(r,0));const saved=h.writes.find(w=>w[0]==='save');expect(saved[1].refreshMinutes).toBeUndefined();expect(saved[1].policy.weights.latency).toBe(90);});
