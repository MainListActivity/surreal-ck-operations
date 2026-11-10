import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../core-errors.ts';
import { Requirements } from './requirements.ts';

export interface FeedbackInput { requestKey:string; text:string; page:string; version:string; contact:string }
export function feedbackInput(value:unknown, origin:string):FeedbackInput {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CompanyError('invalid','反馈格式不正确');
  const input=value as Record<string,unknown>;
  const field=(name:string,max:number,required=false)=>{
    const v=input[name]??'';
    if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw new CompanyError('invalid',`${name} 内容无效或过长`);
    return v.trim();
  };
  const requestKey=field('requestKey',80,true);
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(requestKey))throw new CompanyError('invalid','反馈请求标识无效');
  let page=field('page',1000);
  if(page){let url:URL;try{url=new URL(page);}catch{throw new CompanyError('invalid','反馈页面地址无效');}
    if(url.origin!==origin||url.username||url.password)throw new CompanyError('invalid','反馈页面不属于当前产品来源');
    page=url.origin+url.pathname;
  }
  return {requestKey,text:field('text',6000,true),page,version:field('version',100),contact:field('contact',200)};
}
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('');

/** 公开入口仅收集反馈。数据库凭证留在 Worker；来源校验不是用户认证，限流独立实施。 */
export async function receiveFeedback(db:Surreal,project:string,origin:string,ip:string,body:unknown,now=Date.now()):Promise<{id:string}> {
  if(!/^[a-z][a-z0-9_-]{0,40}$/.test(project))throw new CompanyError('invalid','产品标识无效');
  const policy=await new Requirements(db).policy(project);
  if(!policy?.enabled||!policy.feedbackOrigins.includes(origin))throw new CompanyError('forbidden','该产品未开放此来源的反馈');
  const input=feedbackInput(body,origin);
  const key=await hash(`${project}:${input.requestKey}`),id=new RecordId('product_feedback',key);
  const [previous]=await db.query<[Array<{body:string}>]>('SELECT body FROM $id;',{id});
  if(previous[0]){
    if(previous[0].body!==JSON.stringify(input))throw new CompanyError('conflict','重复请求标识的内容不一致');
    return {id:key};
  }
  const hour=Math.floor(now/3600000),ipKey=await hash(`${project}:${hour}:${ip}`);
  const perIp=new RecordId('product_feedback_rate',ipKey),perProduct=new RecordId('product_feedback_rate',`${project}:${hour}`);
  await db.query(`BEGIN TRANSACTION;
    IF !record::exists($id) {
    IF !record::exists($per_ip) { CREATE $per_ip CONTENT { count: 0, expires_at: $expires }; };
    IF !record::exists($per_product) { CREATE $per_product CONTENT { count: 0, expires_at: $expires }; };
    LET $a = UPDATE $per_ip SET count += 1 WHERE count < 20 RETURN AFTER;
    LET $b = UPDATE $per_product SET count += 1 WHERE count < 1000 RETURN AFTER;
    IF array::len($a) != 1 OR array::len($b) != 1 { THROW 'feedback_rate_limited'; };
    CREATE $id CONTENT { project: $project, request_key: $request_key, body: $body, state: 'new',
      attempts: 0, created_at: time::now(), updated_at: time::now() };
    };
    COMMIT TRANSACTION;`,{id,project,request_key:input.requestKey,body:JSON.stringify(input),
      per_ip:perIp,per_product:perProduct,expires:now+7200000,
    }).retry().catch(async error=>{
      const [buckets]=await db.query<[Array<{count:number}>]>('SELECT count FROM $perIp, $perProduct;',{perIp,perProduct});
      if(buckets[0]?.count>=20||buckets[1]?.count>=1000)throw new CompanyError('limit_reached','反馈提交过于频繁，请稍后再试');
      if(String(error).includes('feedback_rate_limited'))throw new CompanyError('limit_reached','反馈提交过于频繁，请稍后再试');
      throw error;
    });
  const [saved]=await db.query<[Array<{body:string}>]>('SELECT body FROM $id;',{id});
  if(saved[0]?.body!==JSON.stringify(input))throw new CompanyError('conflict','重复请求标识的内容不一致');
  return {id:key};
}
