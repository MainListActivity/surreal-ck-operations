import type {PluginTimelineItemProps} from '@getpaseo/plugin/client';
import {Text,View} from 'react-native';
import type {ModelSwitch} from '../shared/model-switch';
import {relayTheme} from './relay-theme';
import { fs, radius, sp } from '../shared/relay-tokens.ts';
const rate=(n:number|undefined)=>n===undefined?'未知':`${n.toFixed(1)} tok/s`;
const tokens=(n:number|undefined)=>n===undefined?'未知':n>=1000?`${(n/1000).toFixed(1)}k`:String(n);
export function ModelSwitchTimeline({item,theme,layout}:PluginTimelineItemProps<ModelSwitch>){
 const d=item.data,s=d.previous,c=relayTheme(theme).colors;
 return <View style={{paddingVertical:sp(8),paddingHorizontal:layout.compact?sp(10):sp(12),gap:sp(4),borderLeftWidth:sp(2),borderLeftColor:c.accent,backgroundColor:c.surface1,borderRadius:radius(6)}}>
  <Text selectable style={{color:c.foreground,fontSize:fs(12),lineHeight:sp(18),fontWeight:'600'}}>{new Date(d.at).toLocaleTimeString('zh-CN',{hour12:false})} · 模型切换 · {d.from} → {d.to}</Text>
  <Text selectable style={{color:c.foregroundMuted,fontSize:fs(11),lineHeight:sp(17)}}>上一段 · 生成 {rate(s.decodeTokensPerSecond)} · 吞吐 {rate(s.tokensPerSecond)} · 首响应 {s.meanResponseMs===undefined?'未知':`${(s.meanResponseMs/1000).toFixed(2)}s`} · {s.successful} 次成功 · 输出 {tokens(s.outputTokens)}{s.partial?' · 部分观测':''}</Text>
 </View>;
}
