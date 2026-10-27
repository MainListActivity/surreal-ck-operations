import type {PluginAgentPanelProps,PluginTimelineItemProps} from '@getpaseo/plugin/client';
import {Text,View} from 'react-native';
import {metricNumber,metricSeconds,type AgentMetricsView} from '../shared/agent-metrics';
import {relayTheme} from './relay-theme';

function MetricsCard({view,theme,compact=false}:{view:AgentMetricsView;theme:PluginAgentPanelProps['theme'];compact?:boolean}){
 const c=theme.colors,s=view.summary,latest=view.latest;
 const label={color:c.foregroundMuted,fontSize:11},value={color:c.foreground,fontSize:compact?12:13};
 const cell=(title:string,text:string)=><View key={title} style={{minWidth:compact?130:160,flexGrow:1,gap:4,paddingVertical:6}}><Text style={label}>{title}</Text><Text selectable style={value}>{text}</Text></View>;
 return <View style={{padding:compact?12:16,borderRadius:10,backgroundColor:c.surface1,gap:10}}>
  <Text style={{...value,fontWeight:'700'}}>本轮模型实测{s.partial?' · 部分观测':''}</Text>
  <Text style={label}>{s.models.length?s.models.map(m=>`${m.id} ×${m.requests}`).join(' · '):'实际模型未知，等待完成的模型请求。'}</Text>
  <View style={{flexDirection:'row',flexWrap:'wrap',gap:10}}>
   {cell('首个请求 · 首响应',metricSeconds(s.firstResponseMs))}{cell('首个请求 · 首文字',metricSeconds(s.firstTextMs))}
   {cell('本轮输出吞吐（端到端）',s.tokensPerSecond===undefined?'未知':`${metricNumber(s.tokensPerSecond)} tok/s`)}
   {cell('原生生成速度',s.decodeTokensPerSecond===undefined?'未知':`${metricNumber(s.decodeTokensPerSecond)} tok/s`)}
   {cell('本轮请求',`${s.requests} 次 · 成功 ${s.successful} · 失败/中断 ${s.failed} · 进行中 ${view.source==='company-gateway'?s.inFlight:'未知'}`)}
   {cell('已计量输出',s.outputTokens===undefined?'未知':`${metricNumber(s.outputTokens,0)} tokens（${s.tokenRequests} 次）`)}
  </View>
  {!!latest&&<View style={{borderTopWidth:1,borderColor:c.border,paddingTop:10,gap:4}}>
   <Text style={value}>最近一次请求 · {latest.model??'实际模型未知'}</Text>
   {!!latest.reported_model&&<Text style={label}>上游报告：{latest.reported_model}</Text>}
   <Text style={label}>首响应 {metricSeconds(latest.ttft_ms)} · 首文字 {metricSeconds(latest.first_text_ms)} · 耗时 {metricSeconds(latest.total_ms)} · HTTP {latest.status}</Text>
   <Text style={label}>输出 {latest.output_tokens===undefined?'未知':`${metricNumber(latest.output_tokens,0)} tokens`} · 输出吞吐 {latest.completed&&latest.output_tokens!==undefined&&latest.total_ms!==undefined&&latest.total_ms>0?`${metricNumber(latest.output_tokens/(latest.total_ms/1000))} tok/s`:'未知'} · 原生生成速度 {latest.completed&&latest.decodeTokensPerSecond!==undefined?`${metricNumber(latest.decodeTokensPerSecond)} tok/s`:'未知'}</Text>
  </View>}
  <Text style={label}>{view.source==='company-gateway'?'来源：公司模型网关':view.source==='magpie-session'?'来源：Magpie 精确会话匹配':'来源：暂不可用'} · {view.turn?(view.turn.endedAt?'本轮已结束':'本轮进行中'):'尚未记录轮次边界'}</Text>
  {!!view.note&&<Text style={{...label,lineHeight:17}}>{view.note}</Text>}
 </View>;
}
export function AgentMetricsTimeline({item,theme,layout}:PluginTimelineItemProps<AgentMetricsView>){return <MetricsCard view={item.data} theme={relayTheme(theme)} compact={layout.compact}/>;}
