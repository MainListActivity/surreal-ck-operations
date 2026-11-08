/**
 * Cloudflare API 代理（cf.api，只由老板调用）。
 * 只允许公司账号下的路径（/accounts/<CF_ACCOUNT_ID>/...），不接受完整地址、查询串或路径穿越。
 * 请求头里的 API 令牌只在服务端使用，不回显到响应或审计中。
 */
import { CompanyError } from '../../src/core-errors.ts';
import type { Config } from './env.ts';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** 每一段都是普通字符，且不是 . 或 ..（否则 URL 归一化后会跳出账号路径）。 */
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const MAX_BODY_BYTES = 64 * 1024;

export interface CloudflareCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface CloudflareReply {
  status: number;
  success: boolean;
  result: unknown;
  errors: unknown;
}

/** 校验并规范化路径：必须落在公司账号下，每一段都是普通字符。 */
export function accountPath(accountId: string, path: unknown): string {
  if (typeof path !== 'string' || path.length > 300) throw new CompanyError('invalid', 'path invalid');
  const prefix = `/accounts/${accountId}/`;
  if (!path.startsWith(prefix)) throw new CompanyError('forbidden', `只允许 ${prefix} 下的路径`);
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => segment === '' || !SEGMENT.test(segment))) {
    throw new CompanyError('invalid', 'path invalid');
  }
  return path;
}

/** 调用 Cloudflare API。令牌缺失时报 not_configured。 */
export async function cloudflareApi(cfg: Config, call: CloudflareCall, fetchImpl: typeof fetch = fetch): Promise<CloudflareReply> {
  if (!cfg.cf) throw new CompanyError('not_configured', '缺少 CF_ACCOUNT_ID 或 CF_API_TOKEN');
  const method = typeof call.method === 'string' ? call.method.toUpperCase() : '';
  if (!METHODS.has(method)) throw new CompanyError('invalid', 'method invalid');
  const path = accountPath(cfg.cf.accountId, call.path);
  let body: string | undefined;
  if (call.body !== undefined && method !== 'GET') {
    body = JSON.stringify(call.body);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new CompanyError('invalid', 'body too large');
  }
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.cf.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CompanyError('upstream_error', 'Cloudflare API 不可达');
  }
  let parsed: { success?: unknown; result?: unknown; errors?: unknown };
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    throw new CompanyError('upstream_error', 'Cloudflare API 返回了无法解析的响应');
  }
  return { status: response.status, success: parsed.success === true, result: parsed.result ?? null, errors: parsed.errors ?? [] };
}
