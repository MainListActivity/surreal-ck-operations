import { feedbackList, retryFeedback, executionDetail } from '../../src/iteration/inspection.ts';
import type { Surreal } from 'surrealdb';
import { Requirements } from '../../src/iteration/requirements.ts';
import { CompanyError } from '../../src/core-errors.ts';
import { textOf } from './rows.ts';

export const ITERATION_COMMANDS = new Set([
  'feedback.list', 'feedback.retry', 'requirement.control', 'requirement.execution',
  'product.iteration.list', 'product.iteration.get', 'product.iteration.configure',
  'requirement.list', 'requirement.get', 'requirement.create', 'requirement.edit', 'requirement.approve',
]);
/** 所有入口都由命令网关先核对老板身份；actor 必须来自已验签身份，不从 input 读取。 */
export async function iterationCommand(db: Surreal, command: string, input: Record<string, unknown>, actor: string): Promise<unknown> {
  const store = new Requirements(db);
  switch (command) {
    case 'feedback.list': return { feedback: await feedbackList(db,textOf(input.project,'project',80),Number(input.offset??0),input.requirement===undefined?undefined:textOf(input.requirement,'requirement',160)) };
    case 'feedback.retry': await retryFeedback(db,textOf(input.id,'id',160),actor); return {retried:true};
    case 'requirement.control': return {requirement:await store.control(textOf(input.id,'id',160),input.revision as number,textOf(input.action,'action',20),actor)};
    case 'requirement.execution': { const req=await store.get(textOf(input.id,'id',160)); return executionDetail(db,req.id,req.approved_revision??req.revision); }

    case 'product.iteration.list': {
      const [rows] = await db.query<[Array<{id: {id: unknown};name: string}>]>('SELECT id, name FROM project ORDER BY name;');
      return { products: rows.map(p => ({ id: String(p.id.id), name: p.name })) };
    }
    case 'product.iteration.get': return { policy: await store.policy(textOf(input.project, 'project', 80)) ?? null };
    case 'product.iteration.configure': return { policy: await store.configure(textOf(input.project, 'project', 80), input, actor) };
    case 'requirement.list': return { requirements: await store.list(input.project === undefined ? undefined : textOf(input.project, 'project', 80), input.offset === undefined ? 0 : Number(input.offset)) };
    case 'requirement.get': return { requirement: await store.get(textOf(input.id, 'id', 160)) };
    case 'requirement.create': return { requirement: await store.create(input, actor) };
    case 'requirement.edit': return { requirement: await store.edit(textOf(input.id, 'id', 160), input.revision as number, input, actor) };
    case 'requirement.approve': return { approval: await store.approve(textOf(input.id, 'id', 160), input.revision as number, actor, input.expectedPolicy as Record<string,unknown>) };
    default: throw new CompanyError('invalid', '未知需求命令');
  }
}
