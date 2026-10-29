// Product observations come from the configured remote-magpie connection, never the Mac's
// subscription pool. This is a read-only observation, deliberately not an executable v4 proof.
import {lstatSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {CompanyError} from '../core-errors.ts';
import {redactJson} from './redact.ts';
import {parseMagpieJson} from '../usage/magpie.ts';
import {sha256} from './proof-contract.ts';
import {opsFetch,type Fetcher} from './fetcher.ts';

export const PRODUCT_MAGPIE_MODEL='remote-magpie/group/work';
export class ProductGatewaySourceMismatch extends CompanyError{
 constructor(){super('invalid',
  '产品使用已配置的 remote-magpie；本机订阅采样/恢复不能证明产品路由，不得创建本机 work 组或绑定个人 Claude 账号。请使用 ops_product_magpie_observe，并用产品 runtime/逐请求记录核对。',false,
  {reason:'product_gateway_source_mismatch',nextTool:'ops_product_magpie_observe',model:PRODUCT_MAGPIE_MODEL,configurationChangeRequired:false,newBudgetGranted:false});}
}
export function assertLocalMagpieScope(project:string,env:string){
 if(project==='surreal_ck'&&env==='production')throw new ProductGatewaySourceMismatch();
}
type ObjectRow=Record<string,unknown>;
const object=(v:unknown):v is ObjectRow=>!!v&&typeof v==='object'&&!Array.isArray(v);
const list=(v:unknown):ObjectRow[]=>Array.isArray(v)?v.filter(object):[];
const text=(v:unknown)=>typeof v==='string'&&v.length<=240?v:null;
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const price=(v:unknown)=>typeof v==='string'&&/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(v)?number(Number(v)):number(v);
const safeId=(v:unknown)=>typeof v==='string'&&/^[\w.:-]+(?:\/[\w.:-]+)*$/.test(v)&&v.length<=200?v:null;
export function readProductMagpieProvider():unknown{
 try{const path=join(homedir(),'.config','magpie','providers.json'),stat=lstatSync(path);
 if(!stat.isFile()||stat.size>512*1024)throw new CompanyError('not_configured','Magpie 连接配置不可读');
 const config=JSON.parse(readFileSync(path,'utf8')) as ObjectRow;
 return list(config.providers).find(p=>p.id==='remote-magpie');
 }catch{throw new CompanyError('not_configured','remote-magpie 连接配置不可读；不回退本机订阅');}
}
export async function observeProductMagpie(input:{readProvider?:()=>unknown;fetch?:Fetcher;now?:()=>number}){
 const provider=(input.readProvider??readProductMagpieProvider)();
 if(!object(provider)||provider.id!=='remote-magpie'||typeof provider.chat!=='string'||typeof provider.key!=='string'||!provider.key)throw new CompanyError('not_configured','remote-magpie 连接未配置；不回退本机订阅');
 let url:URL;try{url=new URL(provider.chat);}catch{throw new CompanyError('not_configured','remote-magpie 地址无效');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||/^(localhost|127\.|\[?::1)/i.test(url.hostname)||!url.pathname.endsWith('/v1'))throw new CompanyError('not_configured','产品远端连接必须为已有的 HTTPS /v1 地址，不能回退 loopback');
 const fetcher=input.fetch??opsFetch,now=input.now??Date.now,capturedAt=new Date(now()).toISOString();
 const source={kind:'configured-remote-magpie' as const,endpoint:url.href,model:PRODUCT_MAGPIE_MODEL,gatewayModel:'group/work',executionHost:'remote' as const};
 const receipts:Array<{name:string;status:number|null;sha256:string|null;bytes:number;capturedAt:string}>=[];
 const read=async(name:string,path:string)=>{
  let response:Response;try{response=await fetcher(url.href.replace(/\/$/,'')+path,{method:'GET',redirect:'manual',headers:{accept:'application/json',authorization:'Bearer '+provider.key},signal:AbortSignal.timeout(15000)});}catch{throw new CompanyError('upstream_error','remote-magpie 只读来源不可达；未读取本机替代来源',true);}
  if(!response.ok||response.status>=300)throw new CompanyError('upstream_error',`remote-magpie ${name} 返回 HTTP ${response.status}；不据此要求修改产品配置`,true);
  // Stream-bound the input before parsing or hashing. Remote errors/bodies never leave this module.
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  if(!reader)throw new CompanyError('upstream_error','remote-magpie 缺少响应正文');
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>1024*1024)throw new CompanyError('response_too_large','remote-magpie 观测响应超过 1MiB');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const raw=Buffer.concat(chunks).toString('utf8');let value:unknown;try{value=parseMagpieJson(raw);}catch{throw new CompanyError('upstream_error','remote-magpie 未返回有效 JSON');}
  receipts.push({name,status:response.status,sha256:sha256(raw),bytes,capturedAt:new Date(now()).toISOString()});return value;
 };
 const catalogBody=await read('catalog','/models'),quotasBody=await read('quotas','/magpie/quotas'),usageBody=await read('usage','/magpie/usage/requests?period=7d&offset=0&limit=200');
 if(!object(catalogBody)||!Array.isArray(catalogBody.data)||!object(quotasBody)||!Array.isArray(quotasBody.data)||!object(usageBody)||!Array.isArray(usageBody.rows))throw new CompanyError('upstream_error','remote-magpie 观测结构不兼容，不能按空数据处理');
 const catalog=list(catalogBody.data),models=new Map(catalog.map(m=>[m.id,m]));
 const matchingRows=list(usageBody.rows).filter(r=>r.req==='group/work');
 const usage=matchingRows.slice(0,10).filter(r=>r.req==='group/work').map(r=>{
  const status=number(r.status),durationMs=number(r.ms),stop=text(r.stop),model=safeId(r.served)??safeId(r.model),provider=safeId(r.provider);
  const completed=status!==null&&status>=200&&status<300&&durationMs!==null&&durationMs>0&&stop!==null&&['stop','end_turn','tool_use','max_tokens','length','stop_sequence'].includes(stop);
  const identity=typeof r.providerAccount==='string'?r.providerAccount:typeof r.providerKeyId==='string'?r.providerKeyId:null;
  const entry=models.get(provider&&model?provider+'/'+model:'')??catalog.find(m=>m.id===model);
  const pricing=object(entry?.pricing)?entry.pricing:undefined,inputPrice=price(pricing?.prompt),outputPrice=price(pricing?.completion);
  const priced=r.priced===true&&number(r.cost)!==null;
  return {requestId:text(r.response_id),routeId:typeof r.route_id==='number'||typeof r.route_id==='string'?String(r.route_id):null,at:text(r.t),requestedModel:'group/work',servedModel:model,provider,
   accountRef:identity&&provider?'mgp'+sha256('remote-magpie|'+provider+'|'+identity).slice(0,24):null,
   accountBinding:identity?'observed-upstream-identifier':'unknown',completed,status,stop,durationMs,
   usage:{input:number(r.in),output:number(r.out),cacheRead:number(r.cache_read),cacheWrite:number(r.cache_write),reasoning:number(r.reasoning)},
   cost:priced?number(r.cost):null,costUnknown:!priced,
   pricing:{inputPerToken:inputPrice,outputPerToken:outputPrice,free:inputPrice===0&&outputPrice===0,reviewed:false},
  };
 });
 const accounts=list(quotasBody.data).flatMap(row=>{
  const id=safeId(row.provider);if(!id)return [];
  return [{provider:id,accountRef:typeof row.user==='string'?'mgp'+sha256('remote-magpie|'+id+'|'+row.user).slice(0,24):null,kind:safeId(row.kind),readAt:text(row.readAt),windows:list(row.windows).map(w=>({name:safeId(w.name),remainingPct:number(w.remaining),resetsAt:text(w.resetsAt)}))}];
 });
 const result={version:'product-magpie-observation/1',status:'observed',source,capturedAt,route:{present:models.has('group/work'),configurationModified:false},usage,accounts,receipts,
  coverage:{period:'7d',rowsRead:usageBody.rows.length,matchingRows:matchingRows.length,rowsReturned:usage.length,truncated:matchingRows.length>usage.length,total:number(usageBody.total),complete:typeof usageBody.total==='number'&&usageBody.total<=usageBody.rows.length},
  authorization:{executable:false,newBudgetGranted:false,configurationChangeRequired:false},
  nextAction:'核对产品 ops_request GET /api/ops/internal-ai/runtime 和实际 run/requestId；无匹配历史只代表本次有界窗口未找到，不代表缺组。旧 v4 本机账号契约不适用于此源；观测不能作为 prepare/prove/enable 授权。'};
 return redactJson(result,[provider.key,...list(quotasBody.data).flatMap(r=>typeof r.user==='string'?[r.user]:[])]) as typeof result;
}
