import type { Surreal } from 'surrealdb';
import { CompanyError } from '../../src/core-errors.ts';
import { Requirements } from '../../src/iteration/requirements.ts';
import { receiveFeedback } from '../../src/iteration/feedback.ts';
import { readConfig, type Env } from './env.ts';
import { sessionsOf, withSession } from './db.ts';
import { failureOf } from './errors.ts';

const MAX_BYTES=32000;
async function boundedBody(request:Request):Promise<unknown>{
  if(Number(request.headers.get('content-length'))>MAX_BYTES)throw new CompanyError('invalid','反馈内容过大');
  // 经 createOwnerServer 转发的 Request 在异步查策略后直接调 body.getReader() 会触发 Bun 1.3.11 异常；arrayBuffer() 走原生读取并保留大小校验。
  const buffer=await request.arrayBuffer();
  if(buffer.byteLength===0)throw new CompanyError('invalid','反馈内容不能为空');
  if(buffer.byteLength>MAX_BYTES)throw new CompanyError('invalid','反馈内容过大');
  try{return JSON.parse(new TextDecoder().decode(buffer));}catch{throw new CompanyError('invalid','反馈格式无效');}
}
export async function handleFeedbackRequest(request:Request,db:Surreal,project:string):Promise<Response>{
  const origin=request.headers.get('origin')??'';
  let allowed=false;
  const reply=(status:number,body:unknown)=>new Response(status===204?null:JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',vary:'Origin',...(allowed?{'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'}:{})}});
  try{
    if(!origin||!['POST','OPTIONS'].includes(request.method))throw new CompanyError('forbidden','反馈来源不被允许');
    {
      const policy=await new Requirements(db).policy(project);
      if(!policy?.enabled||!policy.feedbackOrigins.includes(origin))throw new CompanyError('forbidden','反馈来源不被允许');
      allowed=true;if(request.method==='OPTIONS')return reply(204,null);
      if(!request.headers.get('content-type')?.startsWith('application/json'))throw new CompanyError('invalid','反馈须使用 JSON');
      // Cloudflare 注入的连接来源；缺失时共享一个受限桶，不能由浏览器传入 IP 来绕过限流。
      const ip=request.headers.get('cf-connecting-ip')??'unknown';
      const receipt=await receiveFeedback(db,project,origin,ip,await boundedBody(request));
      return reply(202,{ok:true,result:receipt});
    }
  }catch(error){const failure=failureOf(error);return reply(error instanceof CompanyError&&error.code==='limit_reached'?429:failure.status,failure.body);}
}

export async function feedbackEndpoint(request:Request,env:Env,project:string):Promise<Response>{
  try {
    const cfg=readConfig(env);
    return await withSession(await sessionsOf(cfg).gateway(),db=>handleFeedbackRequest(request,db,project));
  } catch(error) {
    const failure=failureOf(error);
    return Response.json(failure.body,{status:failure.status,headers:{'cache-control':'no-store'}});
  }
}
