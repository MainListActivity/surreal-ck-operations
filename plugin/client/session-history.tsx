import type {PluginAgentPanelProps,PluginSurfaceProps} from '@getpaseo/plugin/client';
import {useRpc} from '@getpaseo/plugin/client';
import {useQuery} from '@tanstack/react-query';
import {useState,useEffect} from 'react';
import {ScrollView,Text,View,Pressable,TextInput} from 'react-native';
import {sessionHistory} from '../shared/session-history';
function HistoryView({agentId,theme}:Pick<PluginAgentPanelProps,"agentId"|"theme">){
 const read=useRpc(sessionHistory),[pages,setPages]=useState<Array<{cursor:number;textOffset:number}>>([{cursor:0,textOffset:0}]);
 useEffect(()=>setPages([{cursor:0,textOffset:0}]),[agentId]);
 const {cursor,textOffset}=pages[pages.length-1]??{cursor:0,textOffset:0};
 const q=useQuery({queryKey:['company-session-history',agentId,cursor,textOffset],queryFn:()=>read({agentId,cursor,textOffset}),retry:false});
 const c=theme.colors;
 return <ScrollView style={{flex:1,backgroundColor:c.surface0}} contentContainerStyle={{padding:16,gap:12}}>
  <Text style={{color:c.foreground,fontSize:16,fontWeight:'600'}}>只读审阅 · {q.data?.title??'员工会话'}</Text>
  <Text style={{color:c.foregroundMuted}}>{q.data?.notice??'从本地持久记录读取，不启动员工进程。'}</Text>
  {q.isLoading&&<Text style={{color:c.foreground}}>正在读取历史…</Text>}
  {q.error&&<Text selectable style={{color:c.foreground}}>读取失败：{q.error.message}</Text>}
  {q.data?.entries.map((e,i)=><View key={i} style={{paddingVertical:10,borderBottomWidth:1,borderColor:c.border,gap:6}}><Text style={{color:c.foregroundMuted}}>{e.role==='assistant'?'员工':e.role==='user'?'指令／工具结果':'工具'} · {e.at??''}</Text><Text selectable style={{color:c.foreground,fontSize:13}}>{e.text}</Text></View>)}
  <View style={{flexDirection:'row',gap:24}}><Pressable disabled={pages.length<2} onPress={()=>setPages(p=>p.slice(0,-1))}><Text style={{color:c.foreground,opacity:pages.length<2?.4:1}}>上一页</Text></Pressable><Pressable disabled={q.data?.next===undefined} onPress={()=>{if(q.data?.next!==undefined)setPages(p=>[...p,{cursor:q.data!.next!,textOffset:q.data!.nextTextOffset??0}]);}}><Text style={{color:c.foreground,opacity:q.data?.next===undefined?.4:1}}>下一页</Text></Pressable></View>
 </ScrollView>;
}

export function SessionHistoryPanel(props:PluginAgentPanelProps){return <HistoryView agentId={props.agentId} theme={props.theme}/>;}
export function SessionHistorySurface({theme}:PluginSurfaceProps){
 const [draft,setDraft]=useState(''),[agentId,setAgentId]=useState('');const c=theme.colors;
 return <View style={{flex:1,backgroundColor:c.surface0,padding:12,gap:12}}>
  <Text style={{color:c.foreground}}>只读会话审阅（无需先打开原会话）</Text>
  <TextInput accessibilityLabel="员工会话 ID" value={draft} onChangeText={setDraft} placeholder="粘贴 Paseo agent ID" placeholderTextColor={c.foregroundMuted} style={{color:c.foreground,borderColor:c.border,borderWidth:1,padding:10}}/>
  <Pressable onPress={()=>setAgentId(draft.trim())}><Text style={{color:c.foreground}}>读取历史</Text></Pressable>
  {agentId&&<HistoryView key={agentId} agentId={agentId} theme={theme}/>}
 </View>;
}
