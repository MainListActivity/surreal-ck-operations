import {expect,test} from 'bun:test';
const page=await Bun.file(new URL('../plugin/client/company.tsx',import.meta.url)).text();
const source=page.slice(page.indexOf('function RankingJson('),page.indexOf('function RosterTab('));
const compiled=new Bun.Transpiler({loader:'tsx',tsconfig:{compilerOptions:{jsx:'react',jsxFactory:'React.createElement'}}}).transformSync(source+'\nreturn {ModelRankingCard,RankingJson,ModelIdentityCard};');
function harness(data:any) {
 const elements:any[]=[];let states:any[]=[];let cursor=0;
 const React={createElement:(type:any,props:any,...children:any[]):any=>typeof type==='function'?type({...props,children}):{type,props:props??{},children}};
 const useState=(initial:any)=>{const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],(next:any)=>{states[i]=typeof next==='function'?next(states[i]):next;}];};
 const components=new Function('React','useState','useRpc','useQuery','makeStyles','rpc','Section','View','Text','TextInput','Pressable','ExpandableText','Collapsible',compiled)(
  React,useState,()=>()=>{},()=>({data,isError:false}),()=>({}),{},'Section','View','Text','TextInput','Pressable',({text}:any)=>React.createElement('Text',{},text),'Collapsible');
 const render=(name:string,props:any)=>{cursor=0;elements.length=0;const root=components[name](props);const walk=(node:any)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}elements.push(node);node.children?.forEach(walk);};walk(root);return elements;};
 const text=()=>elements.filter(n=>n.type==='Text').map(n=>n.children.flat(Infinity).filter((v:any)=>typeof v==='string'||typeof v==='number').join('')).join('\n');
 return {render,text};
}
test('ranking UI shows default rules and an honest empty state before the first recorded attempt',()=>{
 const h=harness({rules:'智能程度和速度综合优先',refreshMinutes:5,configured:true,orders:{},requests:[]});
 const nodes=h.render('ModelRankingCard',{ctx:{}});
 expect(nodes.find(n=>n.type==='TextInput').props.value).toBe('智能程度和速度综合优先');
 expect(h.text()).toContain('尚无请求快照');
});
test('ranking UI exposes each request timestamp and exact JSON, and JSON sections expand on press',()=>{
 const payload={model:'jev-fixture',state:{ownerRules:'旧规则',models:{m0:{id:'p/a'}}},questions:{m0:{instructions:'排序问题'}}};
 const h=harness({rules:'新规则',refreshMinutes:5,configured:true,orders:{},requests:[{tier:'opus',at:'2026-10-24T02:45:13Z',payload}]});
 h.render('ModelRankingCard',{ctx:{}});
 expect(h.text()).toContain('OPUS');expect(h.text()).toContain('调用开始');
 expect(h.text()).toContain(JSON.stringify(payload,null,2));expect(h.text()).not.toContain('尚无请求快照');
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
