import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../core-errors.ts';
import type { FeedbackInput } from './feedback.ts';
export interface FeedbackView {
  id: string; project: string; state: string; body: FeedbackInput; reason?: string; category?: string; requirement?: string; last_error?: string;
}
export async function feedbackList(db: Surreal, project: string, offset = 0, requirement?: string): Promise<FeedbackView[]> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CompanyError('invalid','分页偏移无效');
  const [rows] = await db.query<[Array<Record<string, any>>]>(
    'SELECT * FROM product_feedback WHERE project=$project AND ($requirement=NONE OR requirement=$requirement) ORDER BY created_at DESC, id LIMIT 50 START $offset;', {project, offset, requirement});
  return rows.map(row => ({ ...row, id:String(row.id.id), body:JSON.parse(row.body) }) as FeedbackView);
}
export async function retryFeedback(db: Surreal, id: string, actor: string): Promise<void> {
  const [rows] = await db.query<[unknown[]]>(`UPDATE $id SET state='new', attempts=0, worker=NONE, reason=NONE, last_error=NONE, actor=$actor, updated_at=time::now()
    WHERE state IN ['failed','dismissed'] RETURN AFTER;`, {id:new RecordId('product_feedback',id),actor});
  if (!rows.length) throw new CompanyError('conflict','仅失败或已忽略的反馈可以重新整理');
}
export async function executionDetail(db: Surreal, id: string, revision: number): Promise<unknown> {
  const [runs] = await db.query<[Array<Record<string, any>>]>('SELECT * FROM $id;', {id:new RecordId('requirement_execution',`${id}:${revision}`)});
  const [plans] = await db.query<[Array<{body:string}>]>('SELECT body FROM $id;', {id:new RecordId('requirement_plan',`${id}:${revision}`)});
  const run = runs[0];
  const [tasks] = await db.query<[unknown[]]>('SELECT id, title, state, acceptance_head FROM task WHERE id IN $ids;', {ids:(run?.tasks??[]).map((id:string)=>new RecordId('task',id))});
  return { execution:run?{...run,id:String(run.id.id)}:null, plan:plans[0]?JSON.parse(plans[0].body):null, tasks };
}
