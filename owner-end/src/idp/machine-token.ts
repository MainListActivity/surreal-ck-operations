/**
 * 机器令牌获取（OAuth client_credentials，client_secret_basic 认证）。
 *
 * 只使用全局 fetch 与 Web 标准 API，不依赖 node: 模块。
 * client_secret 只出现在 Authorization 头中，不进入 URL、日志或错误信息。
 */

import { IdpError } from './admin';

/** 机器令牌请求参数。 */
export interface MachineTokenRequest {
  /** 令牌端点，例如 https://o.maplayer.top/t/company/token */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

/** 提前刷新的余量（秒）。 */
const REFRESH_MARGIN_SECONDS = 60;

/** 默认时钟：unix 秒。 */
const defaultNow = (): number => Math.floor(Date.now() / 1000);

/**
 * 把字符串按 UTF-8 编码后做 base64（不使用 Buffer）。
 * 与 RFC 6749 §2.3.1 一致：先对 client_id 与 client_secret 做表单转义，再以 "id:secret" 做 base64。
 */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** 解析 OAuth 错误码（如 invalid_client）；只接受短小写标识，其它内容一律丢弃。 */
function readOAuthError(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const code = (body as { error: unknown }).error;
      if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) {
        return code;
      }
    }
  } catch {
    // 非 JSON 正文不参与错误信息
  }
  return undefined;
}

/**
 * 获取机器访问令牌。
 * expiresAt 为 unix 秒：now + expires_in - 60；expires_in 不足 120 秒时至少保留 1 秒有效期。
 */
export async function fetchMachineToken(
  req: MachineTokenRequest,
  now: () => number = defaultNow,
): Promise<{ accessToken: string; expiresAt: number }> {
  const doFetch = req.fetch ?? fetch;
  const credentials = `${encodeURIComponent(req.clientId)}:${encodeURIComponent(req.clientSecret)}`;

  const form = new URLSearchParams({ grant_type: 'client_credentials' });

  let response: Response;
  try {
    response = await doFetch(req.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${base64Utf8(credentials)}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
  } catch {
    throw new IdpError('upstream_error', 0, '连接机器令牌端点失败');
  }

  const text = await response.text();
  if (!response.ok) {
    const code = readOAuthError(text);
    const suffix = code === undefined ? '' : `（${code}）`;
    throw new IdpError(
      response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'upstream_error',
      response.status,
      `机器令牌获取失败，状态码 ${response.status}${suffix}`,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new IdpError('upstream_error', response.status, '机器令牌端点返回了非 JSON 响应');
  }

  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new IdpError('upstream_error', response.status, '机器令牌响应缺少 access_token');
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new IdpError('upstream_error', response.status, '机器令牌响应的 expires_in 不正确');
  }

  const validity = Math.max(1, expiresIn - REFRESH_MARGIN_SECONDS);
  return { accessToken, expiresAt: now() + validity };
}

/**
 * 创建机器令牌缓存。
 * - 未过期时直接返回缓存令牌；expiresAt 之后重新获取。
 * - 并发调用合并为一次 loader 调用。
 * - loader 失败不缓存，下次调用会重新获取。
 */
export function createMachineTokenCache(
  loader: () => Promise<{ accessToken: string; expiresAt: number }>,
  now: () => number = defaultNow,
): () => Promise<string> {
  let cached: { accessToken: string; expiresAt: number } | null = null;
  let inflight: Promise<{ accessToken: string; expiresAt: number }> | null = null;

  return async () => {
    if (cached !== null && now() < cached.expiresAt) {
      return cached.accessToken;
    }
    if (inflight === null) {
      inflight = loader()
        .then((result) => {
          cached = result;
          return result;
        })
        .finally(() => {
          inflight = null;
        });
    }
    const result = await inflight;
    return result.accessToken;
  };
}
