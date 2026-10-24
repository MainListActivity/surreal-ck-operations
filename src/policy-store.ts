// 有效策略的读取层（SYS06 P1）。core（创建/领取/租约/关口）与 workforce（调度器派工前判定）都从这里读同一批
// policy 行、并用同一份 policy.ts 判定：判定语义只有一处，两边不会各写一套 SQL 而慢慢漂移。
import { resolveEffective, type EffectiveContract, type PolicyDomain, type PolicyRow, type PolicyScope, type PolicyScopeLink, type PolicyStatus } from './policy.ts';

/** 只用到 query 的最小 DB 面（core 与 workforce 拿到的都是同一个 Surreal 连接）。 */
export interface PolicyStore {
  query<T extends unknown[] = unknown[]>(sql: string, vars?: Record<string, unknown>): Promise<T>;
}

export interface PolicyDbRow {
  id: unknown; policy_id: string; version: number; scope: string; scope_ref?: string | null; domain: string;
  status: string; effective_at: number; expires_at?: number | null; supersedes?: unknown; superseded_by?: unknown;
  revoked_by?: unknown | null; revoke_reason?: string | null; authorization: PolicyRow['authorization'];
  payload: PolicyRow['payload']; hash: string; created_by?: unknown; created_at?: unknown;
}

/** RecordId 的稳定文本形式：`task:abc` 与 RecordId 都读成 `abc`。 */
const asText = (value: unknown): string => {
  const raw = value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value;
  const text = String(raw ?? '');
  return text.includes(':') ? text.split(':').slice(1).join(':') : text;
};

export function policyRowView(row: PolicyDbRow): PolicyRow {
  const asIso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? '');
  return {
    id: asText(row.id), policyId: row.policy_id, version: row.version, scope: row.scope as PolicyScope,
    // 公司作用域的策略没有 scope_ref（库里存成空串）。要读成"没有作用域值"，否则作用域链匹配不上它。
    scopeRef: row.scope_ref ? row.scope_ref : undefined, domain: row.domain as PolicyDomain, status: row.status as PolicyStatus,
    effectiveAt: row.effective_at, expiresAt: row.expires_at ?? undefined,
    supersedes: row.supersedes ? asText(row.supersedes) : undefined, supersededBy: row.superseded_by ? asText(row.superseded_by) : undefined,
    revokeReason: row.revoke_reason ?? undefined,
    revokedBy: row.revoked_by ? asText(row.revoked_by) : undefined,
    authorization: { ...row.authorization, at: row.authorization?.at ?? 0 },
    payload: row.payload, hash: row.hash, createdBy: row.created_by ? asText(row.created_by) : '',
    createdAt: typeof row.created_at === 'number' ? row.created_at : Math.floor(Date.parse(asIso(row.created_at)) / 1000) || 0,
  };
}

/** 作用域链：越靠前越具体，命中即覆盖更宽的域（任务 → 目标 → 项目 → 公司）。 */
export const policyScopeChain = (input: { taskId?: string; goalId?: string; projectId?: string; includeTask?: boolean }): PolicyScopeLink[] => {
  const chain: PolicyScopeLink[] = [];
  if (input.includeTask !== false && input.taskId) chain.push({ scope: 'task', scopeRef: input.taskId });
  if (input.goalId) chain.push({ scope: 'goal', scopeRef: input.goalId });
  if (input.projectId) chain.push({ scope: 'project', scopeRef: input.projectId });
  chain.push({ scope: 'company' });
  return chain;
};

export const chainOfTaskRow = (row: { id: unknown; goal?: unknown; project?: unknown; goal_project?: unknown }): PolicyScopeLink[] =>
  policyScopeChain({
    taskId: asText(row.id),
    goalId: row.goal ? asText(row.goal) : undefined,
    projectId: (row.project ?? row.goal_project) ? asText(row.project ?? row.goal_project) : undefined,
  });

/** 链上可能生效的策略行；只按固定子句组装，作用域值一律走变量。 */
export async function readPolicyRows(db: PolicyStore, chain: readonly PolicyScopeLink[]): Promise<PolicyRow[]> {
  const clauses = chain.map((link, index) =>
    link.scopeRef === undefined
      ? `scope = '${link.scope}'`
      : `(scope = '${link.scope}' AND (scope_ref ?? '') = $ref${index})`);
  const vars: Record<string, unknown> = {};
  chain.forEach((link, index) => { if (link.scopeRef !== undefined) vars[`ref${index}`] = link.scopeRef; });
  const [rows] = await db.query<[PolicyDbRow[]]>(`SELECT * FROM policy WHERE ${clauses.join(' OR ')};`, vars);
  return (rows ?? []).map(policyRowView);
}

/** 生效 epoch：每次策略写入或撤销都 +1；任务/租约登记的契约版本就是它。 */
export async function readPolicyEpoch(db: PolicyStore): Promise<number> {
  const [value] = await db.query<[number | null]>(`RETURN (SELECT VALUE value FROM ONLY company_meta:policy_epoch) ?? 0;`);
  return Math.max(0, Math.floor(value ?? 0));
}

export async function readEffectiveContract(db: PolicyStore, chain: readonly PolicyScopeLink[], now: number): Promise<{ contract: EffectiveContract; rows: PolicyRow[]; epoch: number }> {
  const epoch = await readPolicyEpoch(db);
  const rows = await readPolicyRows(db, chain);
  return { contract: resolveEffective(rows, chain, epoch, now), rows, epoch };
}

/** 任务行上与策略判定有关的字段（带上 goal.project 投影，作用域链需要它）。 */
export interface PolicyTaskRow {
  id: unknown; state: string; executor_role: string;
  work_intent?: { kind: string; lane?: string } | null;
  policy_hash?: string | null; policy_block_reason?: string | null;
  policy_contract?: { domains?: Array<{ domain: string }> } | null;
  goal?: unknown; project?: unknown; goal_project?: unknown;
}

/** 登记契约里生效过的域：失效关闭判定需要它（原契约有、当前没有 = 到期/撤销）。 */
export const registeredDomainsOf = (row: { policy_contract?: { domains?: Array<{ domain: string }> } | null }): string[] =>
  (row.policy_contract?.domains ?? []).map(entry => entry.domain);

export async function readTaskPolicyRow(db: PolicyStore, taskId: string): Promise<PolicyTaskRow | undefined> {
  // FROM ONLY 的单条结果就是记录本身（不是数组）；记录不存在时是 NONE。
  // 记录号必须用 type::record() 构造：把 'task:<uuid>' 当字符串塞进 FROM 会被 SurrealQL 当成带 '-' 的表达式解析，
  // 查询不报错但返回空对象——判定就会以为"任务上没有登记过契约"，静默放行。
  const [row] = await db.query<[PolicyTaskRow | null]>(
    `SELECT *, goal.project AS goal_project FROM ONLY type::record('task', $task);`, { task: taskId });
  return row ?? undefined;
}