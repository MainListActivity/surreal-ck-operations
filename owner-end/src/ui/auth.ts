/**
 * 老板端登录：ma_hono OIDC PKCE（company-console 公开 client）。
 *
 * 令牌只放模块内存，并同步到 sessionStorage 键 `sck.owner.session`；PKCE 临时项放在 `sck.owner.pkce`。
 * 不使用 localStorage，不使用 cookie。过期前 60 秒用 refresh_token 续期；续期失败或接口返回 401 则清空并回到登录页。
 */

/** 网关 GET /api/config 的返回。 */
export interface AuthConfig {
  issuer: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  audience: string;
}

export interface Session {
  accessToken: string;
  refreshToken?: string;
  /** 毫秒时间戳。 */
  expiresAt: number;
}

export interface PkcePending {
  state: string;
  verifier: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SESSION_KEY = 'sck.owner.session';
export const PKCE_KEY = 'sck.owner.pkce';
export const CALLBACK_PATH = '/auth/callback';
/** 距离过期不足这么久（毫秒）就续期。 */
export const REFRESH_AHEAD_MS = 60_000;

// ---- 编码与随机数 ----

export function base64UrlOf(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBase64Url(byteCount: number): string {
  return base64UrlOf(crypto.getRandomValues(new Uint8Array(byteCount)));
}

/** code_verifier：32 字节随机数，base64url 编码后 43 个字符。 */
export function newVerifier(): string {
  return randomBase64Url(32);
}

/** code_challenge（S256）：base64url(SHA-256(verifier))。 */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlOf(new Uint8Array(digest));
}

export function newState(): string {
  return randomBase64Url(16);
}

// ---- 授权与回调 ----

/** 拼出授权地址。scope 与 redirect_uri 手工编码，保证 scope 为 %20 而不是 +。 */
export function buildAuthorizeUrl(cfg: AuthConfig, input: { redirectUri: string; state: string; challenge: string }): string {
  const query = [
    ['response_type', 'code'],
    ['client_id', cfg.clientId],
    ['redirect_uri', input.redirectUri],
    ['scope', 'openid offline_access'],
    ['state', input.state],
    ['code_challenge', input.challenge],
    ['code_challenge_method', 'S256'],
  ].map(([k, v]) => `${encodeURIComponent(k ?? '')}=${encodeURIComponent(v ?? '')}`).join('&');
  return `${cfg.authorizeUrl}${cfg.authorizeUrl.includes('?') ? '&' : '?'}${query}`;
}

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/** 解析回调地址的 query（?code=…&state=…）。 */
export function parseCallback(search: string): CallbackParams {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const pick = (key: string): string | undefined => {
    const v = params.get(key);
    return v ? v : undefined;
  };
  return {
    code: pick('code'),
    state: pick('state'),
    error: pick('error'),
    errorDescription: pick('error_description'),
  };
}

/** state 必须存在且与保存的一致。 */
export function stateMatches(expected: string | undefined, returned: string | undefined): boolean {
  return typeof expected === 'string' && expected.length > 0 && expected === returned;
}

/** 换令牌的 form 体：grant_type、code、redirect_uri、client_id、code_verifier。 */
export function codeExchangeBody(input: { code: string; redirectUri: string; clientId: string; verifier: string }): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  }).toString();
}

/** 续期的 form 体：grant_type=refresh_token、refresh_token、client_id。 */
export function refreshBody(input: { refreshToken: string; clientId: string }): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  }).toString();
}

/** 令牌端点的 JSON 返回转成会话。缺少 access_token 或 expires_in 视为失败。 */
export function parseTokenResponse(json: unknown, now: number): Session | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const body = json as Record<string, unknown>;
  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof accessToken !== 'string' || accessToken === '') return undefined;
  const seconds = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : undefined;
  return { accessToken, refreshToken, expiresAt: now + seconds * 1000 };
}

/** 是否需要续期：没有 refresh_token 时不触发续期（由调用方决定是否已过期）。 */
export function needsRefresh(session: Session, now: number): boolean {
  return session.expiresAt - now < REFRESH_AHEAD_MS;
}

// ---- 存储 ----

let storage: StorageLike | undefined = defaultStorage();
let memory: Session | undefined;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

/** 测试或特殊环境可替换存储；传 undefined 表示无存储（只用内存）。 */
export function setAuthStorage(next: StorageLike | undefined): void {
  storage = next;
  memory = undefined;
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.accessToken === 'string' && typeof v.expiresAt === 'number'
    && (v.refreshToken === undefined || typeof v.refreshToken === 'string');
}

export function currentSession(): Session | undefined {
  if (memory) return memory;
  try {
    const raw = storage?.getItem(SESSION_KEY);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (isSession(value)) {
      memory = value;
      return memory;
    }
  } catch {
    // 存储内容损坏，下面统一清掉
  }
  clearSession();
  return undefined;
}

export function storeSession(session: Session): void {
  memory = session;
  try {
    storage?.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // 存储写入失败（配额或隐私模式）：只保留内存中的令牌
  }
}

export function clearSession(): void {
  memory = undefined;
  try {
    storage?.removeItem(SESSION_KEY);
  } catch {
    // 忽略
  }
}

export function savePkce(pending: PkcePending): void {
  try {
    storage?.setItem(PKCE_KEY, JSON.stringify(pending));
  } catch {
    // 忽略：回调时会因为缺少 PKCE 项而提示重新登录
  }
}

/** 读出并删除 PKCE 临时项。 */
export function takePkce(): PkcePending | undefined {
  try {
    const raw = storage?.getItem(PKCE_KEY);
    storage?.removeItem(PKCE_KEY);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v.state === 'string' && typeof v.verifier === 'string') return { state: v.state, verifier: v.verifier };
    }
  } catch {
    // 损坏的临时项视为不存在
  }
  return undefined;
}

// ---- 网络流程 ----

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

let configCache: AuthConfig | undefined;

function isConfig(value: unknown): value is AuthConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['issuer', 'clientId', 'authorizeUrl', 'tokenUrl', 'audience'].every(k => typeof v[k] === 'string' && v[k] !== '');
}

/** GET /api/config（无需登录），成功后缓存。 */
export async function loadConfig(fetcher: Fetcher = fetch): Promise<AuthConfig> {
  if (configCache) return configCache;
  const res = await fetcher('/api/config', { headers: { Accept: 'application/json' } });
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok || !isConfig(json)) throw new Error('登录配置读取失败，请稍后重试');
  configCache = json;
  return json;
}

/** 生成 PKCE 临时项并返回授权地址；调用方负责跳转。 */
export async function beginLogin(origin: string, fetcher: Fetcher = fetch): Promise<string> {
  const cfg = await loadConfig(fetcher);
  const verifier = newVerifier();
  const state = newState();
  const challenge = await challengeOf(verifier);
  savePkce({ state, verifier });
  return buildAuthorizeUrl(cfg, { redirectUri: `${origin}${CALLBACK_PATH}`, state, challenge });
}

export type CallbackResult = { ok: true } | { ok: false; message: string };

/** 回调页：核对 state，换取令牌并保存。失败时返回可显示的中文原因。 */
export async function completeLogin(search: string, origin: string, fetcher: Fetcher = fetch, now: number = Date.now()): Promise<CallbackResult> {
  const params = parseCallback(search);
  const pending = takePkce();
  if (params.error) return { ok: false, message: `登录被拒绝：${params.errorDescription ?? params.error}` };
  if (!pending) return { ok: false, message: '登录状态已失效，请重新登录' };
  if (!params.code) return { ok: false, message: '回调缺少授权码，请重新登录' };
  if (!stateMatches(pending.state, params.state)) return { ok: false, message: '登录校验失败（state 不一致），请重新登录' };
  let cfg: AuthConfig;
  try {
    cfg = await loadConfig(fetcher);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '登录配置读取失败' };
  }
  const redirectUri = `${origin}${CALLBACK_PATH}`;
  let res: Response;
  try {
    res = await fetcher(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: codeExchangeBody({ code: params.code, redirectUri, clientId: cfg.clientId, verifier: pending.verifier }),
    });
  } catch {
    return { ok: false, message: '网络错误，无法完成登录' };
  }
  const json: unknown = await res.json().catch(() => undefined);
  const session = res.ok ? parseTokenResponse(json, now) : undefined;
  if (!session) return { ok: false, message: '令牌换取失败，请重新登录' };
  storeSession(session);
  return { ok: true };
}

let refreshing: Promise<Session | undefined> | undefined;

/**
 * 续期：有 refresh_token 时 POST tokenUrl。成功则替换会话；失败则清空并返回 undefined。
 * 同一时间只发一次续期请求。
 */
export async function refreshSession(fetcher: Fetcher = fetch, now: number = Date.now()): Promise<Session | undefined> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = currentSession();
    if (!current) return undefined;
    if (!current.refreshToken) {
      if (now >= current.expiresAt) clearSession();
      return now >= current.expiresAt ? undefined : current;
    }
    try {
      const cfg = await loadConfig(fetcher);
      const res = await fetcher(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: refreshBody({ refreshToken: current.refreshToken, clientId: cfg.clientId }),
      });
      const json: unknown = await res.json().catch(() => undefined);
      const parsed = res.ok ? parseTokenResponse(json, now) : undefined;
      if (!parsed) {
        clearSession();
        return undefined;
      }
      const next: Session = { ...parsed, refreshToken: parsed.refreshToken ?? current.refreshToken };
      storeSession(next);
      return next;
    } catch {
      clearSession();
      return undefined;
    }
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = undefined;
  }
}

/**
 * 请求前取可用令牌：未过期且不需续期直接返回；需要续期则续期；续期失败或已过期返回 undefined。
 */
export async function accessToken(fetcher: Fetcher = fetch, now: number = Date.now()): Promise<string | undefined> {
  const session = currentSession();
  if (!session) return undefined;
  if (!needsRefresh(session, now)) return session.accessToken;
  const next = await refreshSession(fetcher, now);
  return next?.accessToken;
}

/** 退出：纯前端，清空内存与 sessionStorage。 */
export function signOutLocal(): void {
  clearSession();
  try {
    storage?.removeItem(PKCE_KEY);
  } catch {
    // 忽略
  }
}

export const LOGIN_LABEL = "用 ma_hono 账号登录";
export const LOGIN_HINT = "看板、需求与运维操作都需要老板身份。请用 ma_hono 账号登录。";
