/**
 * 公司 MCP 第二期：company_ops 白名单与次数预算、老板命令 mcp.budget.set / mcp.principal.pending 的共享实现。
 * 白名单常量与 owner-end/src/mcp.ts 共用一份（它从这里 re-export），避免两端漂移。
 * 预算存 task.mcp_budget（{ <tool>: 0..20 }，老板覆盖）与 task.mcp_ops_used（{ delivery, counts }，入队前扣次，
 * delivery 换租约即重置）；pending 主体聚合近 7 天 ops_audit 里未登记主体的 denied 尝试。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { mcpPrincipalsOf } from './mcp-principals.ts';

/** company_ops 允许转发的受控运维命令全集；预算键只能是这里的工具名。 */
export const MCP_OPS_ALLOW = ['ops_origin_status', 'ops_origin_health', 'ops_origin_logs', 'ops_release_diagnose', 'ops_product_pulse', 'ops_health', 'ops_oci'] as const;

const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BUDGET_MIN = 0;
const BUDGET_MAX = 20;

/** 校验 mcp.budget.set 的输入；空对象（或缺省 budget 字段给出空覆盖）= 清除覆盖。返回要落库的 budget 或 NONE。 */
export function parseMcpBudget(input: Record<string, unknown>): { taskId: string; budget: Record<string, number> } {
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
  const id = taskId.startsWith('task:') ? taskId.slice(5) : taskId;
  if (!TASK_ID.test(id)) throw new CompanyError('invalid', 'taskId invalid');
  const raw = input.budget;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CompanyError('invalid', 'budget invalid：要 { <tool>: 0..20 }');
  const budget: Record<string, number> = {};
  for (const [tool, value] of Object.entries(raw)) {
    if (!(MCP_OPS_ALLOW as readonly string[]).includes(tool)) throw new CompanyError('invalid', `budget 工具 ${tool} 不在公司 MCP 白名单内`);
    if (!Number.isInteger(value) || (value as number) < BUDGET_MIN || (value as number) > BUDGET_MAX) {
      throw new CompanyError('invalid', 'budget 次数必须是 0..20 的整数');
    }
    budget[tool] = value as number;
  }
  return { taskId: id, budget };
}

/** 把 mcp.budget.set 落到任务行（空覆盖写 NONE 清除）；任务不存在 → not_found。 */
export async function mcpBudgetSet(db: Surreal, input: Record<string, unknown>): Promise<{ taskId: string; budget: Record<string, number> | null }> {
  const { taskId, budget } = parseMcpBudget(input);
  const [rows] = await db.query<[Array<{ id: unknown }>]>(
    'UPDATE $task SET mcp_budget = $budget RETURN AFTER;',
    { task: new RecordId('task', taskId), budget: Object.keys(budget).length > 0 ? budget : null });
  if (!rows?.length) throw new CompanyError('not_found', '任务不存在');
  return { taskId, budget: Object.keys(budget).length > 0 ? budget : null };
}

export interface McpPendingPrincipal {
  sub: string;
  attempts: number;
  lastAt: unknown;
  lastCommand: string;
}

/**
 * 近 7 天“令牌有效但主体未登记/已停用”的尝试（ops_audit：actor 形如 mcp:<sub>、denied、
 * reason 为未登记拒绝），按 sub 聚合；已登记且 enabled 的 sub 不算 pending，最多 20 条。
 */
export async function mcpPendingPrincipals(db: Surreal): Promise<McpPendingPrincipal[]> {
  const registered = new Set((await mcpPrincipalsOf(db)).filter((item) => item.enabled).map((item) => item.sub));
  const [rows] = await db.query<[Array<{ actor?: unknown; at?: unknown; command?: unknown }>]>(
    `SELECT actor, at, command FROM ops_audit
     WHERE outcome = 'denied' AND reason = 'mcp:该主体没有登记或已停用'
       AND string::starts_with(actor, 'mcp:') AND at > time::now() - 7d
     ORDER BY at DESC LIMIT 500;`, {});
  const bySub = new Map<string, McpPendingPrincipal>();
  for (const row of rows ?? []) {
    const actor = typeof row.actor === 'string' ? row.actor : '';
    const sub = actor.startsWith('mcp:') ? actor.slice(4) : '';
    if (!sub || registered.has(sub)) continue;
    const item = bySub.get(sub) ?? { sub, attempts: 0, lastAt: row.at, lastCommand: '' };
    item.attempts += 1;
    if (!item.lastCommand && typeof row.command === 'string') item.lastCommand = row.command;
    bySub.set(sub, item);
  }
  return [...bySub.values()].slice(0, 20);
}
