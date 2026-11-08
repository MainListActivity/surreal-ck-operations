import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

import worker from '../src/worker.ts';
import type { Env } from '../src/env.ts';
import { ISSUER, JWKS_URL, json, signToken, testEnv, type KeyFixture } from './_support.ts';

// Worker 路由的单测：经默认导出的 fetch 与 scheduled 调用，不访问网络。
// 老板令牌的验签需要 JWKS：这里临时替换 globalThis.fetch，只对 JWKS_URL 返回本文件生成的公钥，其它地址走原始 fetch。
const ORIGIN = 'https://company.test.invalid';
const KID = 'worker-test-kid';
const originalFetch = globalThis.fetch;

let key: KeyFixture;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  key = { keys: createLocalJWKSet({ keys: [jwk] }), privateKey, kid: KID };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === JWKS_URL) return json({ keys: [jwk] });
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const req = (path: string, init?: RequestInit): Request => new Request(`${ORIGIN}${path}`, init);

const bearer = async (claims: Record<string, unknown> = {}): Promise<string> =>
  `Bearer ${await signToken(key, claims)}`;

async function call(path: string, init: RequestInit = {}, env: Env = testEnv()): Promise<{ status: number; body: any }> {
  const response = await worker.fetch(req(path, init), env);
  return { status: response.status, body: await response.json() };
}

describe('GET /api/config 登录配置', () => {
  test('返回裸 JSON（无 ok 字段），含签发者、客户端、授权与令牌地址、受众', async () => {
    const { status, body } = await call('/api/config');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('ok');
    expect(body).toEqual({
      issuer: ISSUER,
      clientId: 'console-client-id',
      authorizeUrl: `${ISSUER}/authorize`,
      tokenUrl: `${ISSUER}/token`,
      audience: 'company',
    });
  });

  test('缺少 IDP_ISSUER：返回非 200 的 {ok:false,error:{code,message}}，code 为 unavailable，不抛出异常', async () => {
    const { status, body } = await call('/api/config', {}, testEnv({ IDP_ISSUER: '' }));
    expect(status).not.toBe(200);
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unavailable');
    expect(typeof body.error.message).toBe('string');
  });
});

describe('GET /api/me 当前老板', () => {
  test('没有认证头：401，code 为 unauthorized', async () => {
    const { status, body } = await call('/api/me');
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false, error: { code: 'unauthorized', message: expect.any(String) } });
  });

  test('员工令牌（ac=agent，绑定任务）：403，不是老板', async () => {
    const { status, body } = await call('/api/me', {
      headers: { authorization: await bearer({ ac: 'agent', task: 't1', rl: [] }) },
    });
    expect(status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('forbidden');
  });

  test('老板令牌：200，返回 {ok:true,result:{sub,roles,exp}}', async () => {
    const { status, body } = await call('/api/me', { headers: { authorization: await bearer() } });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.sub).toBe('owner-user');
    expect(body.result.roles).toEqual(['Owner']);
    expect(typeof body.result.exp).toBe('number');
  });
});

describe('POST /api/cmd 同源、认证与请求体', () => {
  test('Origin 与请求地址的来源不同：403 forbidden，不需要令牌即生效', async () => {
    const { status, body } = await call('/api/cmd', {
      method: 'POST',
      headers: { origin: 'https://evil.test.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'status' }),
    });
    expect(status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('forbidden');
  });

  test('同源但没有令牌：401，且不解析请求体（非 JSON 也不返回 400）', async () => {
    const { status, body } = await call('/api/cmd', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  test('老板令牌但请求体不是合法 JSON：400 invalid（不会走到执行与数据库）', async () => {
    const { status, body } = await call('/api/cmd', {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: await bearer(), 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid');
  });
});

describe('路由兜底', () => {
  test('未知的 /api 路径：404，返回 {ok:false,error:{code:not_found}}', async () => {
    const { status, body } = await call('/api/unknown');
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
  });

  test('非 /api 路径（/、/auth/callback）交给 env.ASSETS，并返回它的响应', async () => {
    const seen: string[] = [];
    const assets = {
      fetch: async (request: Request) => {
        seen.push(new URL(request.url).pathname);
        return new Response('asset-body', { status: 200 });
      },
    };
    const env = testEnv({});
    env.ASSETS = assets;
    for (const path of ['/', '/auth/callback']) {
      const response = await worker.fetch(req(path), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('asset-body');
    }
    expect(seen).toEqual(['/', '/auth/callback']);
  });
});

describe('scheduled 定时任务入口', () => {
  test('调用 ctx.waitUntil 恰好一次，传入的 promise 不抛出（没有定时客户端时失败被内部捕获）', async () => {
    const promises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { promises.push(promise); } };
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      worker.scheduled({ cron: '30 19 * * *' }, testEnv(), ctx);
      expect(promises).toHaveLength(1);
      expect(promises[0]).toBeInstanceOf(Promise);
      await expect(promises[0]).resolves.toBeUndefined();
    } finally {
      console.error = originalError;
    }
    expect(logged.some((args) => args[0] === 'owner-end cron failed')).toBe(true);
  });
});
