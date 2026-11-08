// 身份服务（ma_hono）客户端。客户端机密走 HTTP Basic，只在每次请求时读取，不缓存、不放进 body、不进日志。
import { jwtExpiryMs } from './jwt.ts';

export interface IssuedToken {
  token: string;
  expiresAt: number; // epoch 毫秒
}

export interface IdpClientOptions {
  issuer: string; // 例 https://o.maplayer.top/t/company
  clientId: string;
  clientSecret: () => Promise<string> | string; // 每次请求时读取，由调用方决定来源
  fetch?: typeof fetch;
  now?: () => number;
}

export class IdpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdpError';
    this.code = code;
  }
}

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const AGENT_ID_TOKEN_TYPE = 'urn:ma-hono:params:oauth:token-type:agent-id';
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
// 只接受短的错误码形态，避免把任意上游文本带进错误信息。
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_TTL_SECONDS = 900;

/** https 任意地址；http 只允许本机回环（测试用）。 */
export function isSecureBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

export class IdpClient {
  private readonly issuer: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: IdpClientOptions) {
    if (!isSecureBaseUrl(options.issuer)) throw new IdpError('invalid', '身份服务地址必须是 https，或本机 http');
    this.issuer = options.issuer.replace(/\/+$/, '');
    this.tokenUrl = `${this.issuer}/token`;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** client_credentials 换发客户端令牌，不缓存（缓存由调用方做）。 */
  async clientToken(): Promise<IssuedToken> {
    return this.post(new URLSearchParams({ grant_type: 'client_credentials' }));
  }

  /** 为员工 agent 换发令牌；参数在本地先校验，不合法不发请求。 */
  async exchangeAgentToken(input: { agentUserId: string; taskId: string; ttlSeconds: number }): Promise<IssuedToken> {
    const { agentUserId, taskId, ttlSeconds } = input;
    if (typeof agentUserId !== 'string' || agentUserId === '' || /\s/.test(agentUserId)) {
      throw new IdpError('invalid', 'agent 用户编号不合法');
    }
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new IdpError('invalid', '任务编号不合法');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
      throw new IdpError('invalid', `令牌有效期必须为 1..${MAX_TTL_SECONDS} 秒的整数`);
    }
    return this.post(
      new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token_type: AGENT_ID_TOKEN_TYPE,
        subject_token: agentUserId,
        task_id: taskId,
        ttl: String(ttlSeconds),
      }),
    );
  }

  private async post(form: URLSearchParams): Promise<IssuedToken> {
    const secret = await this.options.clientSecret();
    if (typeof secret !== 'string' || secret === '') throw new IdpError('invalid', '客户端机密为空');
    const basic = Buffer.from(`${this.options.clientId}:${secret}`).toString('base64');

    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      });
    } catch {
      throw new IdpError('upstream_error', '无法连接身份服务');
    }

    const text = await res.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!res.ok) {
      const raw = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
      const code = typeof raw === 'string' && ERROR_CODE.test(raw) ? raw : 'upstream_error';
      // 不回显 error_description，避免上游把敏感内容带进错误信息。
      throw new IdpError(code, `身份服务拒绝请求：${code}（HTTP ${res.status}）`);
    }

    const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
    const token = payload?.access_token;
    if (typeof token !== 'string' || token === '') throw new IdpError('upstream_error', '身份服务响应缺少令牌');

    // 过期时间优先取 JWT exp；取不到再用 expires_in 推算。
    const expMs = jwtExpiryMs(token);
    if (expMs !== undefined) return { token, expiresAt: expMs };
    const expiresIn = payload?.expires_in;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
      throw new IdpError('upstream_error', '身份服务响应缺少有效期');
    }
    return { token, expiresAt: this.now() + expiresIn * 1000 };
  }
}
