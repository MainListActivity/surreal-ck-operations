/**
 * ma_hono 管理 API 客户端（仅使用全局 fetch）。
 *
 * 管理令牌是人工在管理后台创建的 service principal 令牌，本模块不创建。
 * 所有错误信息都不包含令牌、client_secret 或响应正文，只包含状态码与 ma_hono 返回的错误码。
 */

import type { FixedClaimSpec, MachineClientSpec } from './claims';

/** 管理 API 配置。adminToken 只用于 Authorization 头，不写入任何错误信息。 */
export interface IdpAdminConfig {
  /** 管理 API 根地址，例如 https://o.maplayer.top（路径前缀 /admin 由本模块拼接）。 */
  adminBase: string;
  tenantId: string;
  adminToken: string;
  fetch?: typeof fetch;
}

/** IdpError 的错误码，与 HTTP 状态映射见 mapStatusToCode。 */
export type IdpErrorCode = 'unauthorized' | 'forbidden' | 'invalid' | 'not_found' | 'conflict' | 'upstream_error';

/** 身份管理错误。message 为中文，不包含敏感数据。 */
export class IdpError extends Error {
  readonly code: IdpErrorCode;
  readonly status: number;

  constructor(code: IdpErrorCode, status: number, message: string) {
    super(message);
    this.name = 'IdpError';
    this.code = code;
    this.status = status;
  }
}

/** HTTP 状态到错误码的映射；其余状态一律为 upstream_error。 */
function mapStatusToCode(status: number): IdpErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 400:
      return 'invalid';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    default:
      return 'upstream_error';
  }
}

/** ma_hono 错误体形如 {error: "code"}，只取其中的错误码字符串，忽略其它字段。 */
function readErrorCode(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const code = (body as { error: unknown }).error;
      if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) {
        return code;
      }
    }
  } catch {
    // 非 JSON 响应正文不参与错误信息
  }
  return undefined;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

export type AdminMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** 发起管理 API 请求，统一附加 Bearer 头并映射错误。path 以 /admin 开头，由调用方保证。 */
export async function adminRequest(
  cfg: Omit<IdpAdminConfig, 'tenantId'>,
  method: AdminMethod,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const doFetch = cfg.fetch ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.adminToken}` };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await doFetch(joinUrl(cfg.adminBase, path), { method, headers, body: payload });
  } catch {
    throw new IdpError('upstream_error', 0, '连接 ma_hono 管理接口失败');
  }

  const text = await response.text();
  if (!response.ok) {
    const code = readErrorCode(text);
    const suffix = code === undefined ? '' : `（${code}）`;
    throw new IdpError(
      mapStatusToCode(response.status),
      response.status,
      `ma_hono 管理接口返回 ${response.status}${suffix}`,
    );
  }

  try {
    return text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new IdpError('upstream_error', response.status, 'ma_hono 管理接口返回了非 JSON 响应');
  }
}

/** 读取响应中的非空字符串字段，缺失则视为上游协议错误。 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdpError('upstream_error', 200, `ma_hono 响应缺少字段 ${field}`);
  }
  return value;
}

function tenantPath(tenantId: string): string {
  return `/admin/tenants/${encodeURIComponent(tenantId)}`;
}

/** 创建租户（POST /admin/tenants，需要 tenant.write）。 */
export async function createTenant(
  cfg: Omit<IdpAdminConfig, 'tenantId'>,
  input: { slug: string; displayName: string },
): Promise<{ tenantId: string; slug: string }> {
  const res = (await adminRequest(cfg, 'POST', '/admin/tenants', {
    slug: input.slug,
    display_name: input.displayName,
  })) as Record<string, unknown>;
  return {
    tenantId: requireString(res.id, 'id'),
    slug: requireString(res.slug, 'slug'),
  };
}

/** 列出租户下的全部客户端（GET .../clients，需要 client.read；ma_hono 不分页，一次返回全部）。 */
async function listClients(cfg: IdpAdminConfig): Promise<Array<{ client_id: string; client_name: string }>> {
  const res = (await adminRequest(cfg, 'GET', `${tenantPath(cfg.tenantId)}/clients`)) as { clients?: unknown };
  if (!Array.isArray(res.clients)) {
    throw new IdpError('upstream_error', 200, 'ma_hono 客户端列表格式不正确');
  }
  return res.clients.map((c) => {
    const item = c as Record<string, unknown>;
    return {
      client_id: requireString(item.client_id, 'client_id'),
      client_name: requireString(item.client_name, 'client_name'),
    };
  });
}

/**
 * 确保机器客户端存在。按 client_name 精确匹配已有客户端：
 * 存在则返回 created=false 且不返回 secret；不存在则创建并返回一次性 clientSecret。
 */
export async function ensureMachineClient(
  cfg: IdpAdminConfig,
  spec: MachineClientSpec,
): Promise<{ clientId: string; clientSecret?: string; created: boolean }> {
  const existing = (await listClients(cfg)).find((c) => c.client_name === spec.client_name);
  if (existing !== undefined) {
    return { clientId: existing.client_id, created: false };
  }

  const res = (await adminRequest(cfg, 'POST', `${tenantPath(cfg.tenantId)}/clients`, spec)) as Record<
    string,
    unknown
  >;
  return {
    clientId: requireString(res.client_id, 'client_id'),
    clientSecret: requireString(res.client_secret, 'client_secret'),
    created: true,
  };
}

/**
 * 无条件创建机器客户端（POST .../clients）。同名客户端已存在时 ma_hono 返回 409（conflict）。
 * 新 secret 只在返回值中出现一次。
 */
export async function createMachineClient(
  cfg: IdpAdminConfig,
  spec: MachineClientSpec,
): Promise<{ clientId: string; clientSecret: string }> {
  const res = (await adminRequest(cfg, 'POST', `${tenantPath(cfg.tenantId)}/clients`, spec)) as Record<string, unknown>;
  return {
    clientId: requireString(res.client_id, 'client_id'),
    clientSecret: requireString(res.client_secret, 'client_secret'),
  };
}

/** 替换客户端的固定声明（PATCH .../clients/:clientId，access_token_custom_claims 整体替换）。 */
export async function updateClientClaims(
  cfg: IdpAdminConfig,
  clientId: string,
  claims: FixedClaimSpec[],
): Promise<{ clientId: string }> {
  const res = (await adminRequest(cfg, 'PATCH', `${tenantPath(cfg.tenantId)}/clients/${encodeURIComponent(clientId)}`, {
    access_token_custom_claims: claims,
  })) as Record<string, unknown>;
  return { clientId: requireString(res.client_id, 'client_id') };
}

/** 重置客户端密钥（POST .../clients/:clientId/secret/reset，需要 client.write）。新 secret 只在返回值中出现。 */
export async function resetClientSecret(
  cfg: IdpAdminConfig,
  clientId: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const res = (await adminRequest(
    cfg,
    'POST',
    `${tenantPath(cfg.tenantId)}/clients/${encodeURIComponent(clientId)}/secret/reset`,
  )) as Record<string, unknown>;
  return {
    clientId: requireString(res.client_id, 'client_id'),
    clientSecret: requireString(res.client_secret, 'client_secret'),
  };
}

/** 邮箱规范化：与 ma_hono provision-user.ts 一致（trim 后小写）。 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 列出 kind=agent 的用户（GET .../users?kind=agent，需要 user.read）。 */
export async function listAgentUsers(
  cfg: IdpAdminConfig,
): Promise<Array<{ id: string; email: string; displayName: string; status: string }>> {
  const res = (await adminRequest(cfg, 'GET', `${tenantPath(cfg.tenantId)}/users?kind=agent`)) as {
    users?: unknown;
  };
  if (!Array.isArray(res.users)) {
    throw new IdpError('upstream_error', 200, 'ma_hono 用户列表格式不正确');
  }
  return res.users.map((u) => {
    const item = u as Record<string, unknown>;
    return {
      id: requireString(item.id, 'id'),
      email: requireString(item.email, 'email'),
      displayName: typeof item.display_name === 'string' ? item.display_name : '',
      status: typeof item.status === 'string' ? item.status : '',
    };
  });
}

/**
 * 确保 agent 用户存在。按规范化后的 email 在 kind=agent 用户中查找；
 * 未命中则以 kind="agent" 开户（POST .../users，需要 user.provision 或 user.write）。
 */
export async function ensureAgentUser(
  cfg: IdpAdminConfig,
  input: { email: string; displayName: string },
): Promise<{ userId: string; created: boolean }> {
  const email = normalizeEmail(input.email);
  if (email.length === 0) {
    throw new IdpError('invalid', 400, 'agent 用户的 email 不能为空');
  }

  const existing = (await listAgentUsers(cfg)).find((u) => normalizeEmail(u.email) === email);
  if (existing !== undefined) {
    return { userId: existing.id, created: false };
  }

  const res = (await adminRequest(cfg, 'POST', `${tenantPath(cfg.tenantId)}/users`, {
    email,
    display_name: input.displayName.trim(),
    kind: 'agent',
  })) as { user?: unknown };
  const user = res.user as Record<string, unknown> | undefined;
  if (typeof user !== 'object' || user === null) {
    throw new IdpError('upstream_error', 200, 'ma_hono 开户响应缺少 user');
  }
  return { userId: requireString(user.id, 'user.id'), created: true };
}
