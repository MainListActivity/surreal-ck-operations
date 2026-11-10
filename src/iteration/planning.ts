import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../core-errors.ts';
import { Requirements, type Approval } from './requirements.ts';

export interface PlanStep { title: string; context: string; acceptance: string }
export interface IterationPlan { steps: PlanStep[] }
export type PlanRequirement = (approval: Approval) => Promise<unknown>;
export function iterationPlan(value: unknown): IterationPlan {
  const steps = (value as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > 6) throw new CompanyError('invalid', '规划须包含 1–6 个顺序实施任务');
  return { steps: steps.map(step => {
    if (!step || typeof step !== 'object') throw new CompanyError('invalid', '规划任务格式错误');
    const field = (key: string, max: number) => {
      const text = step[key];
      if (typeof text !== 'string' || text.trim().length < 3 || text.length > max) throw new CompanyError('invalid', `规划 ${key} 无效`);
      return text.trim();
    };
    // 模型不能指定执行身份、宿主机、凭证、命令或发布授权。
    return { title: field('title', 160), context: field('context', 1000), acceptance: field('acceptance', 500) };
  }) };
}

/** 只规划老板已确认的快照；认领过期可恢复，第三次失败等待老板重试。 */
export async function planRequirements(db: Surreal, plan: PlanRequirement, now = Date.now()): Promise<{ planned: number; failed: number }> {
  const result = { planned: 0, failed: 0 };
  await db.query(`UPDATE product_requirement SET planning_error='规划重试次数已用尽，请检查后重试' WHERE state='queued' AND planning_attempts >= 3 AND planning_until < $now;`, { now });
  const [rows] = await db.query<[Array<{ id: RecordId; project: string; approved_revision: number }>]>(
    `SELECT * FROM product_requirement WHERE project IN (SELECT VALUE project FROM product_iteration WHERE enabled=true) AND state='queued' AND planned != true AND (planning_attempts ?? 0) < 3
      AND (planning_until = NONE OR planning_until < $now) ORDER BY priority, updated_at LIMIT 1;`, { now });
  for (const row of rows) {
    if (!(await new Requirements(db).policy(row.project))?.enabled) continue;
    const claim = crypto.randomUUID(), requirement = String(row.id.id);
    const [claimed] = await db.query<[unknown[]]>(`UPDATE $id SET planning_claim=$claim, planning_until=$until, planning_attempts=(planning_attempts ?? 0)+1
      WHERE state='queued' AND (planning_until = NONE OR planning_until < $now) RETURN AFTER;`, { id: row.id, claim, now, until: now + 120000 });
    if (!claimed.length) continue;
    let stage = 'approval';
    const started = Date.now();
    try {
      const approvalId = new RecordId('requirement_approval', `${requirement}:${row.approved_revision}`);
      const [approvals] = await db.query<[Array<{ snapshot: string }>]>(`SELECT snapshot FROM $id;`, { id: approvalId });
      if (!approvals[0]) throw new CompanyError('forbidden', '缺少老板确认快照');
      const approval = JSON.parse(approvals[0].snapshot) as Approval;
      const planId = new RecordId('requirement_plan', `${requirement}:${approval.revision}`);
      const [existing] = await db.query<[unknown[]]>('SELECT id FROM $id;', { id: planId });
      if (!existing.length) {
        stage = 'model';
        const parsed = iterationPlan(await plan(approval));
        stage = 'persist';
        await db.query(`BEGIN TRANSACTION;
          LET $claimed=UPDATE $id SET planning_error=NONE WHERE state='queued' AND planning_claim=$claim RETURN AFTER;
          IF array::len($claimed)!=1 { THROW 'planning_claim_lost'; };
          IF !record::exists($plan) { CREATE $plan CONTENT { requirement:$requirement, revision:$revision, approval:$approval,
            body:$body, created_at:time::now() }; };
          COMMIT TRANSACTION;`, { id: row.id, claim, plan: planId, requirement, revision: approval.revision, approval: approvalId, body: JSON.stringify(parsed) }).retry();
      }
      await db.query(`UPDATE $id SET planned=true, planning_until=$until, planning_error=NONE, planning_diagnostic=NONE WHERE planning_claim=$claim;`, { id: row.id, claim, until: now + 60000 });
      result.planned++;
    } catch (error) {
      const diagnostic = { stage, elapsedMs: Date.now() - started, code: error instanceof CompanyError ? error.code : error instanceof SyntaxError ? 'invalid_json' : 'database_error', reason: error instanceof CompanyError ? error.message : undefined };
      await db.query(`UPDATE $id SET planning_error='规划未完成，请检查需求或重试', planning_diagnostic=$diagnostic, planning_until=$until WHERE planning_claim=$claim;`, { id: row.id, claim, until: now + 60000, diagnostic });
      result.failed++;
    }
  }
  return result;
}
