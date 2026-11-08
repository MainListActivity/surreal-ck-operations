/**
 * 数据库命令：db.read（老板与查看者，只允许单条 SELECT）与 db.write（只由老板，任意 SurrealQL）。
 * 两者都用调用方自己的数据库会话执行，权限由数据库决定；网关不使用 root 账号。
 */
import type { Surreal } from 'surrealdb';
import { CompanyError } from '../../src/core-errors.ts';

const MAX_SQL = 20_000;
const MAX_VARS = 50;

/** 读取命令的语句：只能是一条 SELECT，不能调用 HTTP 类函数。 */
export function readStatement(sql: unknown): string {
  if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > MAX_SQL) throw new CompanyError('invalid', 'sql invalid');
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!/^SELECT\b/i.test(trimmed)) throw new CompanyError('invalid', 'db.read 只接受 SELECT');
  if (trimmed.includes(';')) throw new CompanyError('invalid', 'db.read 只接受一条语句');
  if (/\bhttp::/i.test(trimmed)) throw new CompanyError('invalid', 'db.read 不允许调用 http 函数');
  return trimmed;
}

function varsOf(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CompanyError('invalid', 'vars invalid');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_VARS) throw new CompanyError('invalid', 'vars too many');
  return Object.fromEntries(entries);
}

/** 执行只读查询。 */
export async function dbRead(db: Surreal, input: { sql?: unknown; vars?: unknown }): Promise<{ results: unknown[] }> {
  const sql = readStatement(input.sql);
  const results = await db.query<unknown[]>(sql, varsOf(input.vars));
  return { results: Array.isArray(results) ? results : [] };
}

/** 执行写查询（只由老板调用）。SQL 不做解析限制：权限由老板的数据库访问方式决定。 */
export async function dbWrite(db: Surreal, input: { sql?: unknown; vars?: unknown }): Promise<{ results: unknown[] }> {
  if (typeof input.sql !== 'string' || input.sql.trim().length === 0 || input.sql.length > MAX_SQL) {
    throw new CompanyError('invalid', 'sql invalid');
  }
  const results = await db.query<unknown[]>(input.sql, varsOf(input.vars));
  return { results: Array.isArray(results) ? results : [] };
}
