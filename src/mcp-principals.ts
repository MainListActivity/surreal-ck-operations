/**
 * 公司 MCP 主体登记：哪些授权主体（token sub）可以用公司 MCP 工具、各自允许的员工 provider。
 * 存在 company_meta:mcp_principals 一条记录里；默认拒绝——没登记或 enabled=false 的主体调任何工具都是 forbidden。
 * 老板用 mcp.principal.list / mcp.principal.set 管理（见 src/owner-api.ts）；MCP 网关每次请求重读，停用立即生效。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';

export interface McpPrincipal {
  sub: string;
  providers: string[];
  label: string;
  enabled: boolean;
  updated_at?: string;
}

export const MCP_PRINCIPALS_RECORD = new RecordId('company_meta', 'mcp_principals');
export const MCP_PRINCIPAL_SUB = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MCP_PRINCIPAL_PROVIDER = /^[a-z][a-z0-9-]{0,63}$/;

const row = (value: unknown): McpPrincipal | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.sub !== 'string' || !Array.isArray(item.providers)) return undefined;
  return {
    sub: item.sub,
    providers: item.providers.filter((provider): provider is string => typeof provider === 'string'),
    label: typeof item.label === 'string' ? item.label : '',
    enabled: item.enabled === true,
    ...(typeof item.updated_at === 'string' ? { updated_at: item.updated_at } : {}),
  };
};

/** 当前登记的全部主体；记录缺失或形状不符都视为空清单（= 全部拒绝）。 */
export async function mcpPrincipalsOf(db: Surreal): Promise<McpPrincipal[]> {
  const [rows] = await db.query<[Array<{ principals?: unknown }>]>('SELECT principals FROM $record;', {
    record: MCP_PRINCIPALS_RECORD,
  });
  const list = rows?.[0]?.principals;
  if (!Array.isArray(list)) return [];
  return list.map(row).filter((item): item is McpPrincipal => item !== undefined);
}

/** 校验一条登记输入；不合格抛 CompanyError('invalid')。 */
export function parseMcpPrincipal(input: Record<string, unknown>): McpPrincipal {
  const sub = typeof input.sub === 'string' ? input.sub : '';
  if (!MCP_PRINCIPAL_SUB.test(sub)) throw new CompanyError('invalid', 'sub invalid');
  const providers = Array.isArray(input.providers) ? input.providers : undefined;
  if (!providers || providers.length < 1 || providers.length > 8
    || providers.some((provider) => typeof provider !== 'string' || !MCP_PRINCIPAL_PROVIDER.test(provider))) {
    throw new CompanyError('invalid', 'providers invalid');
  }
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label.length > 80) throw new CompanyError('invalid', 'label invalid');
  return {
    sub,
    providers: [...new Set(providers as string[])],
    label,
    enabled: input.enabled === true,
  };
}

/** upsert 一条主体登记（按 sub），返回更新后的完整清单。 */
export async function mcpPrincipalUpsert(db: Surreal, principal: McpPrincipal): Promise<McpPrincipal[]> {
  const principals = await mcpPrincipalsOf(db);
  const rest = principals.filter((item) => item.sub !== principal.sub);
  const next = [...rest, { ...principal, updated_at: new Date().toISOString() }];
  await db.query('UPSERT $record SET principals = $principals;', { record: MCP_PRINCIPALS_RECORD, principals: next });
  return next;
}
