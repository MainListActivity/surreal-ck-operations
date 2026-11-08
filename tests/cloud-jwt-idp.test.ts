import { describe, expect, test } from 'bun:test';
import { jwtExpiryMs } from '../src/cloud/jwt.ts';
import { IdpClient, IdpError } from '../src/cloud/idp.ts';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.c2ln`;
const SECRET = 'client-secret-value-XYZ';
const ISSUER = 'https://o.maplayer.top/t/company';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('jwtExpiryMs', () => {
  test('返回 exp 对应的毫秒时间', () => {
    expect(jwtExpiryMs(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });

  test('无 exp 或格式不对返回 undefined', () => {
    expect(jwtExpiryMs(jwt({ sub: 'x' }))).toBeUndefined();
    expect(jwtExpiryMs('abc')).toBeUndefined();
    expect(jwtExpiryMs('a.!!!.c')).toBeUndefined();
    expect(jwtExpiryMs(`a.${Buffer.from('not json').toString('base64url')}.c`)).toBeUndefined();
  });
});

describe('IdpClient 构造', () => {
  test('issuer 必须是 https 或本机 http', () => {
    expect(() => new IdpClient({ issuer: 'http://evil.example/t', clientId: 'c', clientSecret: () => SECRET })).toThrow();
    expect(() => new IdpClient({ issuer: 'http://127.0.0.1:9/t', clientId: 'c', clientSecret: () => SECRET })).not.toThrow();
  });
});

describe('IdpClient.clientToken', () => {
  test('发送 Basic 头与 client_credentials 表单，body 不含 secret', async () => {
    const { fn, calls } = fakeFetch(() => json({ access_token: jwt({ exp: 2000 }), token_type: 'Bearer', expires_in: 3600 }));
    const client = new IdpClient({ issuer: `${ISSUER}/`, clientId: 'client-1', clientSecret: () => SECRET, fetch: fn, now: () => 1000 });
    const issued = await client.clientToken();

    expect(issued.expiresAt).toBe(2_000_000);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as Call;
    expect(url).toBe(`${ISSUER}/token`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`client-1:${SECRET}`).toString('base64')}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = String(init.body);
    expect(body).not.toContain(SECRET);
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.has('client_secret')).toBe(false);
    expect(params.has('resource')).toBe(false);
  });

  test('token 无 exp 时用 expires_in 推算过期时间', async () => {
    const { fn } = fakeFetch(() => json({ access_token: 'opaque-token', expires_in: 60 }));
    const client = new IdpClient({ issuer: ISSUER, clientId: 'c', clientSecret: () => SECRET, fetch: fn, now: () => 1000 });
    expect((await client.clientToken()).expiresAt).toBe(61_000);
  });

  test('每次请求都读取 clientSecret', async () => {
    let secret = 'first-secret-value';
    const { fn, calls } = fakeFetch(() => json({ access_token: jwt({ exp: 9 }), expires_in: 1 }));
    const client = new IdpClient({ issuer: ISSUER, clientId: 'c', clientSecret: () => secret, fetch: fn });
    await client.clientToken();
    secret = 'second-secret-value';
    await client.clientToken();
    expect((calls[1] as Call).init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('c:second-secret-value').toString('base64')}`,
    });
  });

  test('IdP 返回错误时抛 IdpError，message 不含 secret 或令牌', async () => {
    const { fn } = fakeFetch(() =>
      json({ error: 'invalid_client', error_description: `bad ${SECRET} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln` }, 401),
    );
    const client = new IdpClient({ issuer: ISSUER, clientId: 'c', clientSecret: () => SECRET, fetch: fn });
    const error = await catchError(client.clientToken());
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).code).toBe('invalid_client');
    expect((error as IdpError).message).not.toContain(SECRET);
    expect((error as IdpError).message).not.toContain('eyJ');
    expect((error as IdpError).message).not.toContain('bad');
  });

  test('非 JSON 错误响应 code 为 upstream_error', async () => {
    const { fn } = fakeFetch(() => new Response('<html>oops</html>', { status: 502 }));
    const client = new IdpClient({ issuer: ISSUER, clientId: 'c', clientSecret: () => SECRET, fetch: fn });
    const error = await catchError(client.clientToken());
    expect((error as IdpError).code).toBe('upstream_error');
    expect((error as IdpError).message).toContain('502');
  });
});

describe('IdpClient.exchangeAgentToken', () => {
  test('表单字段完整且 secret 只在 Basic 头中', async () => {
    const { fn, calls } = fakeFetch(() => json({ access_token: jwt({ exp: 5000 }), expires_in: 300 }));
    const client = new IdpClient({ issuer: ISSUER, clientId: 'c', clientSecret: () => SECRET, fetch: fn, now: () => 0 });
    const issued = await client.exchangeAgentToken({ agentUserId: 'agent-user-1', taskId: 'task_01-A', ttlSeconds: 300 });

    expect(issued.expiresAt).toBe(5_000_000);
    const { init } = calls[0] as Call;
    const params = new URLSearchParams(String(init.body));
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(params.get('subject_token_type')).toBe('urn:ma-hono:params:oauth:token-type:agent-id');
    expect(params.get('subject_token')).toBe('agent-user-1');
    expect(params.get('task_id')).toBe('task_01-A');
    expect(params.get('ttl')).toBe('300');
    expect(String(init.body)).not.toContain(SECRET);
    expect((init.headers as Record<string, string>).Authorization).toStartWith('Basic ');
  });

  test('ttl 越界、task_id 非法、agent 用户 id 为空时本地抛错且不发请求', async () => {
    const { fn, calls } = fakeFetch(() => json({ access_token: jwt({ exp: 5000 }) }));
    const client = new IdpClient({ issuer: ISSUER, clientId: 'c', clientSecret: () => SECRET, fetch: fn });
    const bad: Array<{ agentUserId: string; taskId: string; ttlSeconds: number }> = [
      { agentUserId: 'a', taskId: 't', ttlSeconds: 0 },
      { agentUserId: 'a', taskId: 't', ttlSeconds: 901 },
      { agentUserId: 'a', taskId: 't', ttlSeconds: 1.5 },
      { agentUserId: 'a', taskId: 'bad id', ttlSeconds: 10 },
      { agentUserId: 'a', taskId: 'x'.repeat(129), ttlSeconds: 10 },
      { agentUserId: 'a', taskId: '', ttlSeconds: 10 },
      { agentUserId: '', taskId: 't', ttlSeconds: 10 },
      { agentUserId: 'a b', taskId: 't', ttlSeconds: 10 },
    ];
    for (const input of bad) {
      const error = await catchError(client.exchangeAgentToken(input));
      expect(error).toBeInstanceOf(IdpError);
    }
    expect(calls).toHaveLength(0);
  });

  test('ttl 边界 1 与 900 合法', async () => {
    const { fn, calls } = fakeFetch(() => json({ access_token: jwt({ exp: 5000 }) }));
    const client = new IdpClient({ issuer: ISSUER, clientId: 'c', clientSecret: () => SECRET, fetch: fn });
    await client.exchangeAgentToken({ agentUserId: 'a', taskId: 't', ttlSeconds: 1 });
    await client.exchangeAgentToken({ agentUserId: 'a', taskId: 't', ttlSeconds: 900 });
    expect(calls).toHaveLength(2);
  });

  test('IdP 错误时 message 不含 secret 或令牌', async () => {
    const { fn } = fakeFetch(() => json({ error: 'access_denied', error_description: SECRET }, 403));
    const client = new IdpClient({ issuer: ISSUER, clientId: 'c', clientSecret: () => SECRET, fetch: fn });
    const error = await catchError(client.exchangeAgentToken({ agentUserId: 'a', taskId: 't', ttlSeconds: 10 }));
    expect((error as IdpError).code).toBe('access_denied');
    expect((error as IdpError).message).not.toContain(SECRET);
  });
});
