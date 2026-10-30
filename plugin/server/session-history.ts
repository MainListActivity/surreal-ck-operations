// Read native transcripts without resuming Paseo, attaching tools or minting company credentials.
import {open,readdir,readFile,realpath,stat} from 'node:fs/promises';
import {join,sep} from 'node:path';
import type {SessionHistory,HistoryEntry} from '../shared/session-history';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
async function childFile(root:string,filename:string):Promise<string|undefined>{
 const base=await realpath(root).catch(()=>undefined);if(!base)return;
 for(const d of await readdir(base,{withFileTypes:true})){
  if(!d.isDirectory())continue;
  const candidate=join(base,d.name,filename),path=await realpath(candidate).catch(()=>undefined);
  if(path?.startsWith(base+sep)&&(await stat(path)).isFile())return path;
 }
}
function textOf(value:unknown):string {
 if(typeof value==='string')return value;
 if(!Array.isArray(value))return '';
 return value.map((b:any)=>b?.type==='text'?String(b.text??''):b?.type==='tool_use'?`[工具调用] ${b.name??'未知工具'}`:b?.type==='tool_result'?`[工具结果]\n${textOf(b.content)}`:'').filter(Boolean).join('\n');
}
export function historyEntry(row:any):HistoryEntry|undefined{
 const message=row.message;
 const role=message?.role??(row.type==='user'||row.type==='assistant'?row.type:undefined);
 if(!['user','assistant','tool'].includes(role))return;
 const text=textOf(message?.content);if(!text)return;
 // Never render hidden thinking, provider configuration, authentication headers or raw tool inputs.
 const safe=text.replace(/(Bearer\s+)[\w.\-]+/gi,'$1<redacted>').replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,'$1<redacted>');
 return {role,at:typeof row.timestamp==='string'?row.timestamp:undefined,text:Buffer.from(safe).subarray(0,6000).toString('utf8')};
}
export async function readSessionHistory(input:{agentId:string;cursor:number;paseoHome:string;home:string}):Promise<SessionHistory>{
 if(!uuid.test(input.agentId)||!Number.isSafeInteger(input.cursor)||input.cursor<0)throw Error('无效的会话或分页位置');
 const registry=await childFile(join(input.paseoHome,'agents'),input.agentId+'.json');if(!registry)throw Error('未找到会话登记');
 const record=JSON.parse(await readFile(registry,'utf8'));
 if(record.id!==input.agentId||record.labels?.company!=='surreal-ck')throw Error('仅支持公司员工历史');
 const session=record.persistence?.sessionId;if(typeof session!=='string'||!uuid.test(session))throw Error('会话没有可读取的持久记录');
 const provider=record.provider,root=provider==='claude'?join(input.home,'.claude','projects'):provider==='factory-droid'?join(input.home,'.factory','sessions'):undefined;
 if(!root)throw Error('该客户端暂未提供本地只读历史适配');
 const path=await childFile(root,session+'.jsonl');if(!path)throw Error('未找到本地历史文件；不会启动模型补取');
 const file=await open(path,'r'),entries:HistoryEntry[]=[];let cursor=input.cursor,scanned=0,pending=Buffer.alloc(0),bytes=0,oversized=false;
 try{
  const size=(await file.stat()).size;let recordStart=cursor;if(cursor>0){const previous=Buffer.alloc(1);await file.read(previous,0,1,cursor-1);oversized=previous[0]!==10;}if(cursor>size)throw Error('历史文件已变化，请从第一页重新读取');
  // Bound I/O and output independently. A large tool result is skipped rather than loading the whole transcript.
  while(cursor<size&&scanned<2*1024*1024&&entries.length<40&&bytes<30000){
   const buffer=Buffer.alloc(16384),read=await file.read(buffer,0,buffer.length,cursor);if(!read.bytesRead)break;
   const chunk=buffer.subarray(0,read.bytesRead),nl=chunk.indexOf(10),used=nl<0?chunk.length:nl+1;
   cursor+=used;scanned+=used;
   if(!oversized){pending=Buffer.concat([pending,chunk.subarray(0,nl<0?used:nl)]);if(pending.length>256*1024){pending=Buffer.alloc(0);oversized=true;}}
   if(nl>=0||cursor===size){
    if(oversized){entries.push({role:'tool',text:'[超大单条记录已省略]'});}
    else try{const entry=historyEntry(JSON.parse(pending.toString('utf8')));if(entry){entries.push(entry);bytes+=Buffer.byteLength(entry.text);}}catch{}
    pending=Buffer.alloc(0);oversized=false;recordStart=cursor;
   }
  }
  // Small incomplete records replay next page; oversized records continue scanning without decoding a fragment.
  if(pending.length&&!oversized)cursor=recordStart;
  return {title:record.title??'员工历史',provider,entries,next:cursor<size?cursor:undefined,notice:'只读审阅：不运行模型、不恢复员工凭证或任务租约。超大记录及隐藏思考不展示。'};
 }finally{await file.close();}
}
