import { beforeEach, describe, expect, test } from 'bun:test';
import {
  PKCE_KEY, SESSION_KEY, accessToken, beginLogin, buildAuthorizeUrl, challengeOf, clearSession, codeExchangeBody, completeLogin,
  currentSession, needsRefresh, newState, newVerifier, parseCallback, parseTokenResponse, refreshBody, refreshSession, savePkce,
  setAuthStorage, stateMatches, storeSession, takePkce, type AuthConfig, type StorageLike,
} from '../src/ui/auth.ts';
import { onUnauthorized, outcomeOf } from '../src/ui/api.ts';

class MemoryStorage implements StorageLike {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.has(key) ? (this.items.get(key) ?? null) : null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
  removeItem(key: string): void { this.items.delete(key); }
  has(key: string): boolean { return this.items.has(key); }
}

const CONFIG: AuthConfig = {
  issuer: 'https://idp.example.test',
  clientId: 'company-console',
  authorizeUrl: 'https://idp.example.test/authorize',
  tokenUrl: 'https://idp.example.test/token',
  audience: 'sck-owner',
};

/** 按 URL 路由的假 fetch：/api/config 返回配置，令牌端点返回 tokens。 */
function fakeFetch(tokens: (body: URLSearchParams) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url === '/api/config') return Response.json(CONFIG);
    if (url === CONFIG.tokenUrl) return tokens(new URLSearchParams(String(init?.body ?? '')));
    return new Response('not found', { status: 404 });
  };
  return { fetcher, calls };
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  setAuthStorage(storage);
  clearSession();
});

describe('PKCE 编码', () => {
  test('code_challenge 与 RFC 7636 附录 B 的示例一致', async () => {
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('verifier 为 32 字节随机数的 base64url：43 个字符，不含 = + /', () => {
    const v = newVerifier();
    expect(v).toHaveLength(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newVerifier()).not.toBe(v);
  });

  test('state 每次不同，同样是 base64url', () => {
    const s = newState();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newState()).not.toBe(s);
  });
});

describe('授权地址与回调', () => {
  test('授权地址包含全部 PKCE 参数，scope 用 %20 编码', () => {
    const url = buildAuthorizeUrl(CONFIG, { redirectUri: 'https://owner.example.test/auth/callback', state: 'st', challenge: 'ch' });
    expect(url.startsWith('https://idp.example.test/authorize?')).toBe(true);
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=company-console');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fowner.example.test%2Fauth%2Fcallback');
    expect(url).toContain('scope=openid%20offline_access');
    expect(url).toContain('state=st');
    expect(url).toContain('code_challenge=ch');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).not.toContain('scope=openid+');
  });

  test('已有查询串的授权地址用 & 追加', () => {
    const url = buildAuthorizeUrl({ ...CONFIG, authorizeUrl: 'https://idp.example.test/authorize?x=1' }, { redirectUri: 'r', state: 's', challenge: 'c' });
    expect(url).toContain('authorize?x=1&response_type=code');
  });

  test('解析回调的 code 与 state；error 参数单独返回', () => {
    expect(parseCallback('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz', error: undefined, errorDescription: undefined });
    expect(parseCallback('?error=access_denied&error_description=no')).toMatchObject({ error: 'access_denied', errorDescription: 'no' });
    expect(parseCallback('')).toMatchObject({ code: undefined, state: undefined });
  });

  test('state 必须存在且严格相等', () => {
    expect(stateMatches('abc', 'abc')).toBe(true);
    expect(stateMatches('abc', 'abd')).toBe(false);
    expect(stateMatches('abc', undefined)).toBe(false);
    expect(stateMatches(undefined, undefined)).toBe(false);
    expect(stateMatches('', '')).toBe(false);
  });

  test('换令牌的 form 体只包含规定的五个字段', () => {
    const body = new URLSearchParams(codeExchangeBody({ code: 'c1', redirectUri: 'https://o/auth/callback', clientId: 'cc', verifier: 'v1' }));
    expect([...body.keys()].sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('v1');
  });

  test('续期的 form 体包含 grant_type、refresh_token、client_id', () => {
    const body = new URLSearchParams(refreshBody({ refreshToken: 'r1', clientId: 'cc' }));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('r1');
    expect(body.get('client_id')).toBe('cc');
  });
});

describe('令牌与续期', () => {
  test('解析令牌响应：expires_in 换算成毫秒时间戳，refresh_token 可选', () => {
    expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 300 }, 1000))
      .toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 301_000 });
    expect(parseTokenResponse({ access_token: 'a', expires_in: 60 }, 0)).toEqual({ accessToken: 'a', refreshToken: undefined, expiresAt: 60_000 });
  });

  test('缺 access_token 或 expires_in 视为失败', () => {
    expect(parseTokenResponse({ expires_in: 60 }, 0)).toBeUndefined();
    expect(parseTokenResponse({ access_token: 'a' }, 0)).toBeUndefined();
    expect(parseTokenResponse({ access_token: 'a', expires_in: 0 }, 0)).toBeUndefined();
    expect(parseTokenResponse(undefined, 0)).toBeUndefined();
  });

  test('距离过期不足 60 秒才续期', () => {
    const now = 1_000_000;
    expect(needsRefresh({ accessToken: 'a', expiresAt: now + 61_000 }, now)).toBe(false);
    expect(needsRefresh({ accessToken: 'a', expiresAt: now + 59_000 }, now)).toBe(true);
  });

  test('会话同步到 sessionStorage 键 sck.owner.session，清空时移除', () => {
    storeSession({ accessToken: 'a', refreshToken: 'r', expiresAt: 5 });
    expect(JSON.parse(storage.getItem(SESSION_KEY) ?? 'null')).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 5 });
    clearSession();
    expect(storage.has(SESSION_KEY)).toBe(false);
    expect(currentSession()).toBeUndefined();
  });

  test('损坏的会话存储会被清掉', () => {
    storage.setItem(SESSION_KEY, '{不是 json');
    expect(currentSession()).toBeUndefined();
    expect(storage.has(SESSION_KEY)).toBe(false);
  });

  test('续期成功：替换令牌，没有返回新 refresh_token 时沿用旧的', async () => {
    storeSession({ accessToken: 'old', refreshToken: 'r-old', expiresAt: 10_000 });
    const { fetcher, calls } = fakeFetch(body => {
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('r-old');
      return Response.json({ access_token: 'new', expires_in: 300 });
    });
    const next = await refreshSession(fetcher, 0);
    expect(next).toEqual({ accessToken: 'new', refreshToken: 'r-old', expiresAt: 300_000 });
    expect(currentSession()?.accessToken).toBe('new');
    expect(calls.some(c => c.url === CONFIG.tokenUrl)).toBe(true);
  });

  test('续期失败：清空会话并返回 undefined', async () => {
    storeSession({ accessToken: 'old', refreshToken: 'r-old', expiresAt: 10_000 });
    const { fetcher } = fakeFetch(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    expect(await refreshSession(fetcher, 0)).toBeUndefined();
    expect(currentSession()).toBeUndefined();
    expect(storage.has(SESSION_KEY)).toBe(false);
  });

  test('临近过期且有 refresh_token 时，accessToken 先续期再返回', async () => {
    storeSession({ accessToken: 'old', refreshToken: 'r', expiresAt: 30_000 });
    const { fetcher } = fakeFetch(() => Response.json({ access_token: 'fresh', expires_in: 600 }));
    expect(await accessToken(fetcher, 0)).toBe('fresh');
  });

  test('没有 refresh_token 且已过期：accessToken 返回 undefined 并清空', async () => {
    storeSession({ accessToken: 'old', expiresAt: 1_000 });
    const { fetcher } = fakeFetch(() => new Response('x', { status: 500 }));
    expect(await accessToken(fetcher, 2_000)).toBeUndefined();
    expect(currentSession()).toBeUndefined();
  });
});

describe('登录与回调', () => {
  test('beginLogin 保存 {state, verifier} 到 sck.owner.pkce，并返回带 S256 挑战的授权地址', async () => {
    const { fetcher } = fakeFetch(() => new Response('x', { status: 500 }));
    const url = await beginLogin('https://owner.example.test', fetcher);
    const pending = JSON.parse(storage.getItem(PKCE_KEY) ?? 'null') as { state: string; verifier: string };
    expect(pending.state.length).toBeGreaterThan(10);
    expect(pending.verifier).toHaveLength(43);
    expect(url).toContain(`state=${pending.state}`);
    expect(url).toContain(`code_challenge=${await challengeOf(pending.verifier)}`);
    expect(url).toContain('redirect_uri=https%3A%2F%2Fowner.example.test%2Fauth%2Fcallback');
  });

  test('state 不一致：报错，不请求令牌端点，并删除 PKCE 项', async () => {
    savePkce({ state: 'expected', verifier: 'v' });
    const { fetcher, calls } = fakeFetch(() => Response.json({ access_token: 'x', expires_in: 60 }));
    const result = await completeLogin('?code=c&state=other', 'https://owner.example.test', fetcher, 0);
    expect(result.ok).toBe(false);
    expect(calls.some(c => c.url === CONFIG.tokenUrl)).toBe(false);
    expect(storage.has(PKCE_KEY)).toBe(false);
    expect(currentSession()).toBeUndefined();
  });

  test('没有 PKCE 项（例如刷新了回调页）：报错并要求重新登录', async () => {
    const { fetcher } = fakeFetch(() => Response.json({ access_token: 'x', expires_in: 60 }));
    const result = await completeLogin('?code=c&state=s', 'https://owner.example.test', fetcher, 0);
    expect(result).toEqual({ ok: false, message: '登录状态已失效，请重新登录' });
  });

  test('state 一致：换令牌，保存会话，清掉 PKCE 项，表单带 code_verifier', async () => {
    savePkce({ state: 'st1', verifier: 'ver1' });
    const { fetcher } = fakeFetch(body => {
      expect(body.get('code')).toBe('code-1');
      expect(body.get('code_verifier')).toBe('ver1');
      expect(body.get('redirect_uri')).toBe('https://owner.example.test/auth/callback');
      return Response.json({ access_token: 'tok', refresh_token: 'ref', expires_in: 300 });
    });
    const result = await completeLogin('?code=code-1&state=st1', 'https://owner.example.test', fetcher, 0);
    expect(result).toEqual({ ok: true });
    expect(currentSession()).toEqual({ accessToken: 'tok', refreshToken: 'ref', expiresAt: 300_000 });
    expect(storage.has(PKCE_KEY)).toBe(false);
  });

  test('takePkce 读出后即删除', () => {
    savePkce({ state: 's', verifier: 'v' });
    expect(takePkce()).toEqual({ state: 's', verifier: 'v' });
    expect(takePkce()).toBeUndefined();
  });
});

describe('401 处理', () => {
  test('接口返回 401：清空令牌并通知壳层回到登录页', async () => {
    storeSession({ accessToken: 'a', expiresAt: Date.now() + 600_000 });
    let notified = 0;
    onUnauthorized(() => { notified += 1; });
    const out = await outcomeOf(new Response(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '未登录' } }), { status: 401 }));
    expect(out.kind).toBe('error');
    expect(notified).toBe(1);
    expect(currentSession()).toBeUndefined();
    expect(storage.has(SESSION_KEY)).toBe(false);
  });

  test('403 非老板不清空令牌（只显示原因）', async () => {
    storeSession({ accessToken: 'a', expiresAt: Date.now() + 600_000 });
    const out = await outcomeOf(new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message: '不是老板' } }), { status: 403 }));
    expect(out).toMatchObject({ kind: 'error', code: 'forbidden' });
    expect(currentSession()?.accessToken).toBe('a');
  });

  test('202 pending：网关把任务号放在 error.message 里', async () => {
    const out = await outcomeOf(new Response(JSON.stringify({ ok: false, error: { code: 'pending', message: 'job-42' } }), { status: 202 }));
    expect(out).toEqual({ kind: 'pending', jobId: 'job-42', message: '已排队，执行端处理中' });
  });
});
