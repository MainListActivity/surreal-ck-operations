// Product observations come from the configured remote-magpie connection, never the Mac's
// subscription pool. This is a read-only observation, deliberately not an executable v4 proof.
import {lstatSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {CompanyError} from '../core-errors.ts';
import {redactJson} from './redact.ts';
import {parseMagpieJson} from '../usage/magpie.ts';
import {sha256,MAGPIE_SNAPSHOT_MAX_AGE_SECONDS} from './proof-contract.ts';
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

// Usage windows grow without bound in production (total was 45852 when the first 200 rows carried no
// match), so the read is a bounded scan: at most USAGE_MAX_PAGES requests of USAGE_PAGE_LIMIT rows,
// bounded again by rows, cumulative bytes and wall time. A bound hit is reported as incomplete, never
// treated as "no data"; a remote that stops advancing while it still claims rows fails closed.
const USAGE_PERIOD='7d',USAGE_PAGE_LIMIT=200,USAGE_MAX_PAGES=5,USAGE_MAX_ROWS=USAGE_PAGE_LIMIT*USAGE_MAX_PAGES,
 USAGE_MAX_BYTES=4*1024*1024,USAGE_BUDGET_MS=12_000,MAX_RETURNED_ROWS=10;
type StopReason='end-of-window'|'row-cap'|'page-cap'|'time-cap';

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
 const receipts:Array<{name:string;status:number|null;sha256:string|null;bytes:number;capturedAt:string}>=[];let calls=0;
 const read=async(name:string,path:string)=>{
  calls++;
  let response:Response;try{response=await fetcher(url.href.replace(/\/$/,'')+path,{method:'GET',redirect:'manual',headers:{accept:'application/json',authorization:'Bearer '+provider.key},signal:AbortSignal.timeout(15000)});}catch{throw new CompanyError('upstream_error','remote-magpie 只读来源不可达；未读取本机替代来源',true);}
  if(!response.ok||response.status>=300)throw new CompanyError('upstream_error',`remote-magpie ${name} 返回 HTTP ${response.status}；不据此要求修改产品配置`,true);
  // Stream-bound the input before parsing or hashing. Remote errors/bodies never leave this module.
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  if(!reader)throw new CompanyError('upstream_error','remote-magpie 缺少响应正文');
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>1024*1024)throw new CompanyError('response_too_large','remote-magpie 观测响应超过 1MiB');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const raw=Buffer.concat(chunks).toString('utf8');let value:unknown;try{value=parseMagpieJson(raw);}catch{throw new CompanyError('upstream_error','remote-magpie 未返回有效 JSON');}
  receipts.push({name,status:response.status,sha256:sha256(raw),bytes,capturedAt:new Date(now()).toISOString()});return {value,bytes};
 };
 const catalogBody=(await read('catalog','/models')).value,quotasBody=(await read('quotas','/magpie/quotas')).value;
 if(!object(catalogBody)||!Array.isArray(catalogBody.data)||!object(quotasBody)||!Array.isArray(quotasBody.data))throw new CompanyError('upstream_error','remote-magpie 观测结构不兼容，不能按空数据处理');
 // Bounded usage scan: collect the first matching rows while reading every row the bounds allow, so the
 // receipt can say exactly how much of the window was inspected.
 const scanStarted=now();let offset=0,pages=0,rowsRead=0,usageBytes=0,total:number|null=null,stop:StopReason='end-of-window',matched=0;
 const matchingRows:ObjectRow[]=[];
 for(;;){
  if(pages>=USAGE_MAX_PAGES){stop='page-cap';break;}
  if(rowsRead>=USAGE_MAX_ROWS){stop='row-cap';break;}
  if(now()-scanStarted>USAGE_BUDGET_MS){stop='time-cap';break;}
  const page=await read('usage',`/magpie/usage/requests?period=${USAGE_PERIOD}&q=${encodeURIComponent('group/work')}&offset=${offset}&limit=${USAGE_PAGE_LIMIT}`);
  usageBytes+=page.bytes;
  if(usageBytes>USAGE_MAX_BYTES)throw new CompanyError('response_too_large','remote-magpie usage 分页累计超过 4MiB');
  const body=page.value;
  if(!object(body)||!Array.isArray(body.rows))throw new CompanyError('upstream_error','remote-magpie 观测结构不兼容，不能按空数据处理');
  const rows=list(body.rows),pageTotal=number(body.total);
  if(pageTotal!==null)total=pageTotal;
  pages++;
  for(const row of rows)if(row.req==='group/work'){matched++;if(matchingRows.length<MAX_RETURNED_ROWS)matchingRows.push(row);}
  rowsRead+=rows.length;offset+=rows.length;
  if(rows.length===0){
   if(total!==null&&offset<total)throw new CompanyError('upstream_error','remote-magpie usage 分页未推进（仍声明有行但返回空页）');
   stop='end-of-window';break;
  }
  if(rows.length<USAGE_PAGE_LIMIT||(total!==null&&offset>=total)){stop='end-of-window';break;}
 }
 const complete=stop==='end-of-window'&&(total===null||offset>=total);
 const catalog=list(catalogBody.data),models=new Map(catalog.map(m=>[m.id,m]));
 const usage=matchingRows.map(r=>{
  const status=number(r.status),durationMs=number(r.ms),stopFlag=text(r.stop),model=safeId(r.served)??safeId(r.model),provider=safeId(r.provider);
  const completed=status!==null&&status>=200&&status<300&&durationMs!==null&&durationMs>0&&stopFlag!==null&&['stop','end_turn','tool_use','max_tokens','length','stop_sequence'].includes(stopFlag);
  const identity=typeof r.providerAccount==='string'?r.providerAccount:typeof r.providerKeyId==='string'?r.providerKeyId:null;
  const entry=models.get(provider&&model?provider+'/'+model:'')??catalog.find(m=>m.id===model);
  const pricing=object(entry?.pricing)?entry.pricing:undefined,inputPrice=price(pricing?.prompt),outputPrice=price(pricing?.completion);
  const priced=r.priced===true&&number(r.cost)!==null;
  // The account reference is derived from the upstream identity the row itself carries. When that is
  // derivable, accountBinding is the same reference the window contract compares against; otherwise
  // the row stays `unknown` and is never guessed from another account's quota row.
  const accountRef=identity&&provider?'mgp'+sha256('remote-magpie|'+provider+'|'+identity).slice(0,24):null;
  return {requestId:text(r.response_id),routeId:typeof r.route_id==='number'||typeof r.route_id==='string'?String(r.route_id):null,at:text(r.t),requestedModel:'group/work',servedModel:model,provider,
   accountRef,accountBinding:accountRef??'unknown',completed,status,stop:stopFlag,durationMs,
   usage:{input:number(r.in),output:number(r.out),cacheRead:number(r.cache_read),cacheWrite:number(r.cache_write),reasoning:number(r.reasoning)},
   cost:priced?number(r.cost):null,costUnknown:!priced,
   pricing:{inputPerToken:inputPrice,outputPerToken:outputPrice,free:inputPrice===0&&outputPrice===0,reviewed:false},
  };
 });
 const accounts=list(quotasBody.data).flatMap(row=>{
  const id=safeId(row.provider);if(!id)return [];
  return [{provider:id,accountRef:typeof row.user==='string'?'mgp'+sha256('remote-magpie|'+id+'|'+row.user).slice(0,24):null,kind:safeId(row.kind),readAt:text(row.readAt),windows:list(row.windows).map(w=>({name:safeId(w.name),remainingPct:number(w.remaining),resetsAt:text(w.resetsAt)}))}];
 });
 // Route fields come only from what the read-only surfaces actually expose. Anything else stays a
 // structured null with a gap; nothing is derived from the local clock or local configuration.
 const routeEntry=models.get('group/work'),firstMatch=matchingRows[0];
 const routeRevision=text(routeEntry?.revision??routeEntry?.config_revision),
  routeDigest=text(routeEntry?.digest??routeEntry?.route_digest),
  routeMaxOutputTokens=number(routeEntry?.max_output_tokens??routeEntry?.maxOutputTokens),
  routeServedModel=firstMatch?(safeId(firstMatch.served)??safeId(firstMatch.model)):null,
  routeSampledAt=firstMatch?text(firstMatch.t):null,
  routeExpiresAt=text(routeEntry?.expiresAt??routeEntry?.expires_at??firstMatch?.expiresAt);
 const routeGaps:Array<{field:string;reason:string}>=[];const gap=(field:string,reason:string)=>routeGaps.push({field,reason});
 if(routeRevision===null)gap('revision','远端只读目录未提供该路由的 revision；不自行编造');
 if(routeDigest===null)gap('digest','远端只读接口未提供路由 digest；本工具不计算替代摘要');
 if(routeServedModel===null)gap('servedModel','扫描范围内无 group/work 匹配行，无法取得实际服务模型');
 if(routeMaxOutputTokens===null)gap('maxOutputTokens','远端只读目录未提供该路由的 max_output_tokens');
 if(routeSampledAt===null)gap('sampledAt','无上游采样时刻；不使用本机时钟补造');
 if(routeExpiresAt===null)gap('expiresAt','远端只读接口未提供该路由的到期时刻');
 const windowContractMaxOutputTokens=65536;
 const result={version:'product-magpie-observation/1',status:'observed',source,capturedAt,
  route:{present:models.has('group/work'),configurationModified:false,revision:routeRevision,digest:routeDigest,servedModel:routeServedModel,maxOutputTokens:routeMaxOutputTokens,sampledAt:routeSampledAt,expiresAt:routeExpiresAt,gaps:routeGaps},
  usage,accounts,receipts,
  executionBounds:{modelMaxOutputTokens:routeMaxOutputTokens,windowContractMaxOutputTokens,proposedRequestMaxOutputTokens:routeMaxOutputTokens!==null&&routeMaxOutputTokens>0?Math.min(routeMaxOutputTokens,windowContractMaxOutputTokens):null,requiresApprovedWindow:true,enforcement:'product InternalBudgetModel caps each actual request at the approved window limit'},
  observationSnapshot:{capturedAt,digest:sha256(JSON.stringify({source,receipts})),maxAgeSeconds:MAGPIE_SNAPSHOT_MAX_AGE_SECONDS,freshnessExpiresAt:new Date(Date.parse(capturedAt)+MAGPIE_SNAPSHOT_MAX_AGE_SECONDS*1000).toISOString(),expiryBasis:'local-observation-freshness-policy',routingConfigurationVerified:false},
  coverage:{period:USAGE_PERIOD,filter:{field:'q',value:'group/work',exactRequestedModel:'group/work'},rowsRead,matchingRows:matched,rowsReturned:usage.length,truncated:!complete,rowsTruncated:matched>usage.length,total,complete,pages,stoppedReason:stop,scannedOffset:[0,offset] as [number,number],requestCount:calls,
   bounds:{pageSize:USAGE_PAGE_LIMIT,maxPages:USAGE_MAX_PAGES,maxRows:USAGE_MAX_ROWS,maxBytes:USAGE_MAX_BYTES,budgetMs:USAGE_BUDGET_MS},routeFieldsComplete:routeGaps.length===0},
  authorization:{executable:false,newBudgetGranted:false,configurationChangeRequired:false},
  nextAction:'模型支持的最大输出不是请求必须使用的上限；请求应由获批窗口及产品调用层限制。observationSnapshot仅是本次读取的新鲜度策略，不是远端路由revision或供应商到期证明。核对产品 ops_request GET /api/ops/internal-ai/runtime 和实际 run/requestId；本次只说明以上有界扫描范围内的结果，扫描未完成或为空都不代表缺组或缺数据。旧 v4 本机账号契约不适用于此源；观测不能作为 prepare/prove/enable 授权。'};
 return redactJson(result,[provider.key,...list(quotasBody.data).flatMap(r=>typeof r.user==='string'?[r.user]:[])]) as typeof result;
}
