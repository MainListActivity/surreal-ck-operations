import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../core-errors.ts';
import { Requirements, requirementContent } from './requirements.ts';
import type { FeedbackInput } from './feedback.ts';

export interface FeedbackDecision {
  disposition:'new'|'existing'|'dismiss';
  category:'bug'|'feature'|'question'|'noise';
  reason:string;
  requirementId?:string;
  title?:string;
  problem?:string;
  acceptance?:string;
  priority?:number;
}
export interface TriageInput {feedback:FeedbackInput;candidates:Array<{id:string;title:string;problem:string}>}
export type ClassifyFeedback=(input:TriageInput)=>Promise<unknown>;
export function feedbackDecision(value:unknown,candidates:readonly string[]):FeedbackDecision{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CompanyError('invalid','反馈整理结果格式错误');
  const v=value as Record<string,unknown>;
  if(!['new','existing','dismiss'].includes(String(v.disposition))||!['bug','feature','question','noise'].includes(String(v.category)))throw new CompanyError('invalid','反馈整理结果分类无效');
  if(typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>1200)throw new CompanyError('invalid','反馈整理必须给出有界理由');
  if(v.disposition==='existing'&&(typeof v.requirementId!=='string'||!candidates.includes(v.requirementId)))throw new CompanyError('invalid','反馈只能关联本产品提供的候选需求');
  return v as unknown as FeedbackDecision;
}

/** 使用现有云端唤醒。每条反馈通过有期限的认领处理，有限重试；模型没有工具，也不能确认需求。 */
export async function triageFeedback(db:Surreal,classify:ClassifyFeedback,now=Date.now()):Promise<{linked:number;dismissed:number;failed:number}>{
  const result={linked:0,dismissed:0,failed:0};
  await db.query(`UPDATE product_feedback SET state='failed', last_error='整理重试次数已用尽，请人工检查或重试', updated_at=time::now() WHERE state='processing' AND lease_until < $now AND attempts >= 3;`,{now});
  const [pending]=await db.query<[Array<{id:RecordId;project:string;body:string}>]>(
    `SELECT * FROM product_feedback WHERE (state = 'new' OR (state = 'processing' AND lease_until < $now)) AND attempts < 3 ORDER BY created_at LIMIT 3;`,{now});
  for(const feedback of pending){
    if(!(await new Requirements(db).policy(feedback.project))?.enabled)continue;
    const claimToken=crypto.randomUUID();
    const [claimed]=await db.query<[unknown[]]>(`UPDATE $id SET state='processing', worker=$claimToken, lease_until=$until, attempts+=1, updated_at=time::now()
      WHERE (state='new' OR (state='processing' AND lease_until < $now)) AND attempts < 3 RETURN AFTER;`,{id:feedback.id,claimToken,now,until:now+120000});
    if(!claimed.length)continue;
    try{
      const store=new Requirements(db);
      const policy=await store.policy(feedback.project);
      if(!policy?.enabled)throw new CompanyError('not_configured','产品迭代已停用');
      const candidates=(await store.list(feedback.project)).filter(r=>!['rejected','merged'].includes(r.state)).slice(0,30).map(r=>({id:r.id,title:r.title,problem:r.problem.slice(0,600)}));
      const original=JSON.parse(feedback.body) as FeedbackInput;
      // 联系方式不参与模型推理；仅供老板按需回访。
      const answer=feedbackDecision(await classify({feedback:{...original,contact:''},candidates}),candidates.map(r=>r.id));
      const id=answer.disposition==='new'?`feedback-${String(feedback.id.id)}`:answer.requirementId;
      const content=answer.disposition==='new'?requirementContent({project:feedback.project,title:answer.title,problem:answer.problem,acceptance:answer.acceptance??'',priority:answer.priority??2}):undefined;
      await db.query(`BEGIN TRANSACTION;
        LET $changed=UPDATE $feedback SET state=$state, category=$category, reason=$reason, requirement=$requirement, updated_at=time::now()
          WHERE state='processing' AND worker=$claimToken RETURN AFTER;
        IF array::len($changed)!=1 { THROW 'feedback_claim_lost'; };
        IF $create = true AND !record::exists($req) {
          CREATE $req CONTENT { project:$content.project, title:$content.title, problem:$content.problem, acceptance:$content.acceptance,
            priority:$content.priority, revision:1, state:'pending', actor:'automation:feedback', created_at:time::now(), updated_at:time::now() };
        };
        COMMIT TRANSACTION;`,{feedback:feedback.id,claimToken,state:answer.disposition==='dismiss'?'dismissed':'linked',category:answer.category,reason:answer.reason,
          requirement:id,req:new RecordId('product_requirement',id??'unused'),create:answer.disposition==='new',content});
      if(answer.disposition==='dismiss')result.dismissed++;else result.linked++;
    }catch{
      // 不把原始反馈或上游响应写进日志；错误可重试最多三次，老板可以手动恢复。
      await db.query(`UPDATE $id SET state=IF attempts >= 3 THEN 'failed' ELSE 'new' END, last_error='反馈整理未完成，请重试或人工整理', updated_at=time::now()
        WHERE state='processing' AND worker=$claimToken;`,{id:feedback.id,claimToken});
      result.failed++;
    }
  }
  await db.query('DELETE product_feedback_rate WHERE expires_at < $now;',{now});
  return result;
}
