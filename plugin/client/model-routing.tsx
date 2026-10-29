import type {PluginSurfaceProps} from '@getpaseo/plugin/client';
import {useRpc} from '@getpaseo/plugin/client';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useEffect,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import * as rpc from '../shared/rpc';
import type {ModelCatalogPage,ModelRankingPolicy,ModelRankingTable} from '../shared/types';
import {ROUTING_WEIGHTS,ROUTING_DEFAULTS,ROUTING_FORMULA,ROUTING_COST_HELP,routingMetrics,routingNumber,routingTrends,routingCalculation} from '../shared/model-routing-view';
import {rankingTrendDetail} from '../shared/ranking-trends';
import {relayPalette} from './relay-theme';
type Props={ctx:{theme:PluginSurfaceProps['theme'];compact:boolean}};
const GROUPS=['sck-haiku','sck-sonnet','sck-opus','sck-fable'] as const;
const label=(group:string)=>group.replace('sck-','').replace(/^./,x=>x.toUpperCase());

export function ModelRoutingPanel({ctx}:Props){
 const palette=relayPalette(ctx.theme),c=palette.core,client=useQueryClient();
 const get=useRpc(rpc.modelRanking),preview=useRpc(rpc.previewModelRanking),save=useRpc(rpc.saveModelRanking),pin=useRpc(rpc.pinModelRanking);
 const catalogRpc=useRpc(rpc.modelCatalog),membership=useRpc(rpc.setModelMembership),alias=useRpc(rpc.setModelAlias);
 const data=useQuery({queryKey:['model-ranking'],queryFn:()=>get({}),refetchInterval:15000});
 const [width,setWidth]=useState(ctx.compact?390:1100),[group,setGroup]=useState<string>('sck-haiku'),[mode,setMode]=useState<'ranking'|'catalog'>('ranking');
 const [policy,setPolicy]=useState<ModelRankingPolicy>(),[previewPolicy,setPreviewPolicy]=useState<ModelRankingPolicy>();
 const [search,setSearch]=useState(''),[catalogSearch,setCatalogSearch]=useState(''),[offset,setOffset]=useState(0),[shown,setShown]=useState(12);
 const [expanded,setExpanded]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const effective:ModelRankingPolicy=policy??data.data?.policy??ROUTING_DEFAULTS;
 const dirty=!!policy&&JSON.stringify(effective)!==JSON.stringify(data.data?.policy??ROUTING_DEFAULTS);
 useEffect(()=>{if(!dirty){setPreviewPolicy(undefined);return;}setPreviewPolicy(undefined);const t=setTimeout(()=>setPreviewPolicy(effective),450);return()=>clearTimeout(t);},[JSON.stringify(effective),dirty]);
 useEffect(()=>{const t=setTimeout(()=>{setCatalogSearch(search);setOffset(0);setShown(12);},300);return()=>clearTimeout(t);},[search]);
 const previewData=useQuery({queryKey:['routing-preview',previewPolicy],queryFn:()=>preview({policy:previewPolicy!,refresh:false}),enabled:!!previewPolicy,retry:false});
 const catalog=useQuery({queryKey:['model-catalog',catalogSearch,offset],queryFn:()=>catalogRpc({query:catalogSearch,offset,limit:40}),enabled:mode==='catalog'});
 const tables=dirty?(JSON.stringify(previewPolicy)===JSON.stringify(effective)?previewData.data?.tables:[]):data.data?.tables;
 const table=tables?.find(t=>t.group===group);
 const rows=(table?.rows??[]).filter(row=>row.model.toLowerCase().includes(search.toLowerCase()));
 const mobile=width<650,side=width>960;
 const text={color:c.foreground,fontSize:12,lineHeight:19},muted={color:c.foregroundMuted,fontSize:10,lineHeight:16};
 const panel={backgroundColor:c.surface1,borderWidth:1,borderColor:c.border,borderRadius:14,padding:mobile?14:19};
 const input={backgroundColor:c.surface2,borderWidth:1,borderColor:c.border,borderRadius:8,padding:10,color:c.foreground,fontSize:12};
 const button=(title:string,onPress:()=>void,selected=false,disabled=false)=><Pressable accessibilityRole='button' accessibilityState={{selected,disabled}} disabled={disabled||busy} onPress={onPress} style={{paddingVertical:8,paddingHorizontal:11,borderRadius:8,borderWidth:1,borderColor:selected?c.accent:c.border,backgroundColor:selected?palette.accentSoft:c.surface1,opacity:disabled||busy?0.5:1}}><Text style={{...text,color:selected?c.accent:c.foreground}}>{title}</Text></Pressable>;
 const action=async(write:()=>Promise<unknown>,success:string)=>{setBusy(true);setMessage('');try{await write();await Promise.all([client.invalidateQueries({queryKey:['model-catalog']}),data.refetch()]);setMessage(success);}catch(e){setMessage((e as Error).message);await Promise.all([client.invalidateQueries({queryKey:['model-catalog']}),data.refetch()]);}finally{setBusy(false);}};
 const heading=(step:string,title:string,subtitle:string)=><View style={{flexDirection:'row',gap:10,alignItems:'center',marginBottom:18}}><View style={{padding:9,borderRadius:9,backgroundColor:palette.accentSoft}}><Text style={{...muted,color:c.accent,fontWeight:'700'}}>{step}</Text></View><View style={{flex:1}}><Text style={{...text,fontSize:14,fontWeight:'700'}}>{title}</Text><Text style={muted}>{subtitle}</Text></View></View>;
 return <View onLayout={e=>setWidth(e.nativeEvent.layout.width)} style={{gap:20,paddingVertical:12}}>
  <View style={{gap:5}}><Text style={{...muted,color:c.accent,letterSpacing:1.5}}>MODEL ROUTING</Text><Text style={{...text,fontSize:28,lineHeight:36,fontWeight:'700'}}>模型排序</Text><Text style={muted}>评分、真实实测与模型管理。Haiku / Sonnet 自动排序，Opus / Fable 保持手动。</Text></View>
  <View style={{flexDirection:side?'row':'column',gap:13,alignItems:side?'flex-start':'stretch'}}>
   <View style={{...panel,...(side?{width:280}:{})}}>
    {heading('01','评分规则','非线性计算 · 无模型调用费用')}
    <Text style={muted}>{ROUTING_FORMULA}</Text>
    {Object.entries(ROUTING_WEIGHTS).map(([key,title])=><View key={key} style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:12}}><Text style={text}>{title}</Text><TextInput accessibilityLabel={`${title}权重`} keyboardType='numeric' style={{...input,width:65}} value={String(effective.weights[key as keyof typeof effective.weights])} onChangeText={v=>setPolicy({...effective,weights:{...effective.weights,[key]:Number(v)}})}/></View>)}
    <Text style={{...muted,marginTop:12}}>延迟以20秒为衰减参考，连续扣分；未知指标使用保守先验，未测延迟通过有限探索获得样本。</Text>
    <View style={{marginTop:14}}>{button('保存设置',()=>void action(async()=>{await save({rules:data.data?.rules??'',policy:effective});setPolicy(undefined);},'已保存，排序已立即生效。'),true,!data.data||!dirty&&!data.data?.error)}</View>
    <View style={{flexDirection:'row',gap:6,flexWrap:'wrap',marginTop:8}}>{button('恢复默认',()=>setPolicy({...ROUTING_DEFAULTS,billingOverrides:effective.billingOverrides}))}{button('更新观测',()=>void action(async()=>{await preview({policy:effective,refresh:true});await client.invalidateQueries({queryKey:['routing-preview']});},'已更新实测，未修改线上排序。'))}</View>
    <Text style={{...muted,marginTop:12}}>{dirty?(previewData.isError?'预览失败，请更新观测；线上未变更。':previewData.data?'预览中，保存前不影响线上。':'正在计算预览…'):'保存后立即重算并应用；请求读取已生效顺序，实测数据最多每30秒后台更新。'}</Text>
    <Text style={{...muted,marginTop:10}}>{ROUTING_COST_HELP}</Text>
   </View>
   <View style={{...panel,flex:1,minWidth:0}}>
    {heading('02','模型优先级与管理',dirty?'配置预览 · 未应用线上':'实时成员 · 按总分排序')}
    <View style={{flexDirection:'row',gap:5,backgroundColor:c.surface2,padding:4,borderRadius:10,marginBottom:14,flexWrap:'wrap'}}>{GROUPS.map(g=><Pressable key={g} accessibilityRole='tab' accessibilityState={{selected:group===g}} onPress={()=>{setGroup(g);setShown(12);}} style={{flex:1,minWidth:65,padding:9,borderRadius:7,backgroundColor:group===g?c.surface1:'transparent'}}><Text style={{...text,color:group===g?c.accent:c.foregroundMuted,textAlign:'center'}}>{label(g)} <Text style={muted}>{data.data?.tables.find(t=>t.group===g)?.rows.length??0}</Text></Text></Pressable>)}</View>
    <View style={{flexDirection:'row',gap:7,marginBottom:12}}>{button('当前排序',()=>setMode('ranking'),mode==='ranking')}{button('管理模型',()=>setMode('catalog'),mode==='catalog')}</View>
    <TextInput accessibilityLabel='搜索模型或供应商' style={{...input,marginBottom:12}} value={search} onChangeText={setSearch} placeholder='搜索模型或供应商' placeholderTextColor={c.foregroundMuted}/>
    {!!message&&<Text accessibilityRole='alert' style={{...text,color:c.accent,marginBottom:10}}>{message}</Text>}
    {(data.isError||data.data?.error)&&<Text accessibilityRole='alert' style={{...text,color:palette.danger}}>读取或刷新未完成：{data.data?.error??'请重试'}</Text>}
    {mode==='ranking'?<View style={{gap:5}}>
     <Text style={{...muted,marginBottom:7}}>{group==='sck-opus'||group==='sck-fable'?'本组按你维护的顺序，自动公式不修改成员或顺序。':'手动置顶之后，全部模型仅比较总分；展开可查看因子和管理操作。'}</Text>
     {rows.slice(0,shown).map((row,index)=>{const open=expanded===row.model,parts=row.model.replace(/^remote-magpie\//,'').split('/'),name=parts.pop(),f=row.decision?.factors;return <View key={row.model} style={{borderWidth:1,borderColor:open?c.accent:c.border,borderRadius:9,overflow:'hidden',backgroundColor:c.surface1}}>
      <Pressable accessibilityRole='button' accessibilityState={{expanded:open}} onPress={()=>setExpanded(open?'':row.model)} style={{flexDirection:'row',alignItems:'center',gap:9,padding:10}}>
       <View style={{width:30,padding:5,borderRadius:8,backgroundColor:c.surface2}}><Text style={muted}>#{(table?.rows.indexOf(row)??index)+1}</Text></View><View style={{flex:1,minWidth:0}}><Text numberOfLines={1} style={{...text,fontWeight:'600'}}>{name}</Text><Text style={muted}>{parts.join('/')} {row.pinned?'· 手动置顶':''}</Text></View>
       {!mobile&&<View style={{width:62}}><Text style={muted}>智能分</Text><Text style={text}>{routingNumber(row.aaScore)}</Text></View>}{!mobile&&<View style={{width:70}}><Text style={muted}>首 token</Text><Text style={text}>{row.ttftMs===undefined?'未知':`${routingNumber(row.ttftMs/1000)}s`}</Text></View>}
       <View style={{width:55,alignItems:'flex-end'}}><Text style={muted}>总分</Text><Text style={{...text,color:palette.score,fontSize:17,fontWeight:'700'}}>{routingNumber(row.decision?.score)}</Text></View><Text style={muted}>{open?'−':'+'}</Text>
      </Pressable>
      {open&&<View style={{padding:12,gap:10,borderTopWidth:1,borderColor:c.border}}><Text selectable style={{...muted,fontFamily:'Menlo'}}>{row.model}</Text><Text style={muted}>{row.decision?.reason??'本组手动维护，尚无自动评分'}</Text>
       <View style={{flexDirection:'row',flexWrap:'wrap',gap:10}}>{routingMetrics(row).map(([title,value,detail])=><View key={title} style={{width:mobile?'46%':'30%',gap:2}}><Text style={muted}>{title}</Text><Text selectable style={{...text,fontWeight:'600'}}>{value}</Text><Text style={muted}>{detail}</Text></View>)}</View>
       {f&&<Text selectable style={muted}>{routingCalculation(row)}</Text>}
       <View style={{gap:3}}>{Object.entries(row.decision?.contributions??{}).map(([key,value])=><Text key={key} style={muted}>{ROUTING_WEIGHTS[key as keyof typeof ROUTING_WEIGHTS]}：原始分 {routingNumber(value.value===undefined?undefined:value.value*100)} / 100 · 权重 {value.weight} · 乘数 {routingNumber(value.factor,3)}</Text>)}</View>
       {routingTrends(row).map(([title,trend])=><Text key={title} style={muted}>{title}：{rankingTrendDetail(trend)}</Text>)}
       <View style={{flexDirection:'row',flexWrap:'wrap',gap:7}}>{['sck-haiku','sck-sonnet'].includes(group)&&button(row.pinned?'取消置顶':'置顶模型',()=>void action(()=>pin({group:group as 'sck-haiku',model:row.model,pinned:!row.pinned}),'置顶已更新。'),!!row.pinned,dirty)}{button('管理此模型',()=>{setSearch(row.model.replace(/:(low|medium|high|xhigh|max)$/,''));setMode('catalog');})}</View>
       <View style={{flexDirection:'row',gap:5,flexWrap:'wrap'}}>{Object.entries({auto:'自动计费',free:'免费',included:'订阅/积分',unknown:'未知',paid:'额外付费'}).map(([kind,title])=><View key={kind}>{button(title,()=>{const overrides={...effective.billingOverrides};if(kind==='auto')delete overrides[row.model];else overrides[row.model]=kind as 'free';setPolicy({...effective,billingOverrides:overrides});},(effective.billingOverrides[row.model]??'auto')===kind)}</View>)}</View>
      </View>}
     </View>})}
     {!rows.length&&<Text style={muted}>{data.isLoading?'正在读取…':'本组暂无匹配成员，可在“管理模型”中添加。'}</Text>}
     {shown<rows.length&&button(`显示其余 ${rows.length-shown} 个模型`,()=>setShown(shown+20))}
     {!!table?.at&&<Text style={{...muted,marginTop:10}}>最近排序：{new Date(table.at).toLocaleString()} · {rows.length} 个匹配模型</Text>}
    </View>:<View style={{gap:8}}>
     <Text style={muted}>从实时 Magpie 目录添加成员，或选择有分数的 AA 对应模型。修改分组不改变其他分组；目录已排除 group/ 和 auto/。</Text>
     {catalog.isError&&<Text accessibilityRole='alert' style={{...text,color:palette.danger}}>目录读取失败，请重试。</Text>}
     {catalog.data?.models.map(model=><CatalogModel key={model.id} model={model} benchmarks={catalog.data!.benchmarks} group={group} ctx={ctx} busy={busy} onMembership={input=>action(()=>membership(input),'分组与排序已生效。')} onAlias={slug=>action(()=>alias({model:model.id,slug}),'AA 关联已保存。')}/>)}
     {!catalog.data?.models.length&&<Text style={muted}>{catalog.isLoading?'正在读取目录…':'没有匹配模型。'}</Text>}
     <View style={{flexDirection:'row',gap:8,alignItems:'center'}}>{button('上一页',()=>setOffset(Math.max(0,offset-40)),false,offset===0)}<Text style={muted}>{catalog.data?.models.length?offset+1:0}–{offset+(catalog.data?.models.length??0)} / {catalog.data?.total??0}</Text>{button('下一页',()=>setOffset(catalog.data?.nextOffset??offset),false,catalog.data?.nextOffset==null)}</View>
    </View>}
   </View>
  </View>
 </View>;
}

function CatalogModel({model,benchmarks,group,ctx,busy,onMembership,onAlias}:{model:ModelCatalogPage['models'][number];benchmarks:ModelCatalogPage['benchmarks'];group:string;ctx:Props['ctx'];busy:boolean;onMembership:(input:{group:'sck-haiku';model:string;present:boolean;expectedMembers:string[]})=>Promise<void>;onAlias:(slug:string|null)=>Promise<void>}){
 const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[effort,setEffort]=useState(model.levels.includes('max')?'max':model.levels[0]??'');
 const p=relayPalette(ctx.theme),c=p.core,text={color:c.foreground,fontSize:12,lineHeight:19},muted={color:c.foregroundMuted,fontSize:10,lineHeight:16};
 const members=model.members[group]??[];
 const choices=benchmarks.filter(b=>(b.name+' '+b.slug).toLowerCase().includes(search.toLowerCase())).slice(0,8);
 const button=(title:string,action:()=>void)=><Pressable accessibilityRole='button' disabled={busy} onPress={action} style={{padding:8,borderRadius:7,borderWidth:1,borderColor:c.border,opacity:busy?0.5:1}}><Text style={text}>{title}</Text></Pressable>;
 return <View style={{borderWidth:1,borderColor:c.border,borderRadius:9,padding:10,gap:8}}>
  <Pressable accessibilityRole='button' accessibilityState={{expanded:open}} onPress={()=>setOpen(!open)}><Text style={{...text,fontWeight:'600'}}>{model.name}</Text><Text style={muted}>{model.id}</Text><Text style={muted}>{model.aa?`AA ${routingNumber(model.aa.score)} · ${model.aa.name}`:'尚未关联 AA'} · {model.groups.map(label).join(' / ')||'未入组'} {open?'−':'+'}</Text></Pressable>
  {open&&<View style={{gap:8}}>
   <View style={{flexDirection:'row',gap:5,flexWrap:'wrap'}}>{['',...model.levels].map(level=><View key={level}>{button(`${effort===level?'✓ ':''}${level||'默认思考'}`,()=>setEffort(level))}</View>)}</View>
   {button(`添加到 ${label(group)}`,()=>void onMembership({group:group as 'sck-haiku',model:model.id+(effort?':'+effort:''),present:true,expectedMembers:members}))}
   {members.map(member=><View key={member}>{button(`移出 ${label(group)} · ${member.split('/').pop()}`,()=>void onMembership({group:group as 'sck-haiku',model:member,present:false,expectedMembers:members}))}</View>)}
   <Text style={muted}>关联 AA 模型（仅展示已评分条目，支持搜索）</Text><TextInput accessibilityLabel={`${model.id} 搜索AA模型`} value={search} onChangeText={setSearch} placeholder='搜索 AA 名称或 slug' placeholderTextColor={c.foregroundMuted} style={{padding:9,borderRadius:8,borderWidth:1,borderColor:c.border,color:c.foreground,fontSize:12}}/>
   {choices.map((b,index)=><View key={b.slug+index}>{button(`${model.slug===b.slug?'✓ ':''}${b.name} · ${routingNumber(b.score)}`,()=>void onAlias(b.slug))}</View>)}
   {button('标记为不对应 AA',()=>void onAlias(null))}
  </View>}
 </View>;
}
