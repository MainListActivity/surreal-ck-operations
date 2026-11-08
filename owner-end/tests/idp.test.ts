import { describe, expect, test } from 'bun:test';

import {
  CLIENT_TOKEN_AUDIENCE,
  IdpError,
  MACHINE_ROLE_CLAIMS,
  RESERVED_CLAIM_NAMES,
  createMachineTokenCache,
  createTenant,
  ensureAgentUser,
  ensureMachineClient,
  fetchMachineToken,
  fixedClaimsFor,
  listAgentUsers,
  machineClientSpec,
  resetClientSecret,
  type MachineRole,
} from '../src/idp/index';

const ADMIN_BASE = 'https://o.maplayer.top';
const TENANT_ID = 'b1f0c6a2-1111-4222-8333-444455556666';
const ADMIN_TOKEN = 'ADMIN-TOKEN-FAKE-123';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  rawBody: string | null;
  body: unknown;
}

/** 假 fetch：记录每次请求，并由 handler 决定响应。 */
function fakeFetch(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const isJson = (headers.get('content-type') ?? '').includes('application/json');
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      rawBody,
      body: rawBody !== null && isJson ? JSON.parse(rawBody) : rawBody,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function adminCfg(f: typeof fetch) {
  return { adminBase: ADMIN_BASE, tenantId: TENANT_ID, adminToken: ADMIN_TOKEN, fetch: f };
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('admin: createTenant', () => {
  test('POST /admin/tenants 带 Bearer 与 JSON 正文，返回 tenantId', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(201, { id: 'tenant-uuid-1', slug: 'company', display_name: 'Company', issuer: 'x' }),
    );
    const result = await createTenant({ adminBase: ADMIN_BASE, adminToken: ADMIN_TOKEN, fetch }, {
      slug: 'company',
      displayName: 'Company',
    });

    expect(result).toEqual({ tenantId: 'tenant-uuid-1', slug: 'company' });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${ADMIN_BASE}/admin/tenants`);
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(calls[0].body).toEqual({ slug: 'company', display_name: 'Company' });
  });

  test('slug 已存在返回 409 时映射为 conflict', async () => {
    const { fetch } = fakeFetch(() => json(409, { error: 'conflict' }));
    const error = await createTenant({ adminBase: ADMIN_BASE, adminToken: ADMIN_TOKEN, fetch }, {
      slug: 'company',
      displayName: 'Company',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).code).toBe('conflict');
    expect((error as IdpError).status).toBe(409);
  });
});

describe('admin: ensureMachineClient', () => {
  const spec = machineClientSpec('gateway', { clientName: 'gateway-machine', ns: 'company', db: 'main' });

  test('同名客户端已存在：created=false，不创建、不返回 secret', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, {
        clients: [
          { id: 'x', client_id: 'other-id', client_name: 'other' },
          { id: 'y', client_id: 'gateway-id', client_name: 'gateway-machine' },
        ],
      }),
    );
    const result = await ensureMachineClient(adminCfg(fetch), spec);

    expect(result).toEqual({ clientId: 'gateway-id', created: false });
    expect(result.clientSecret).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${ADMIN_BASE}/admin/tenants/${TENANT_ID}/clients`);
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  test('不存在则 POST 创建，正文含固定声明与 company 受众，返回一次性 secret', async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.method === 'GET') return json(200, { clients: [] });
      return json(201, { client_id: 'new-id', client_secret: 'SECRET-NEW-XYZ', client_name: 'gateway-machine' });
    });
    const result = await ensureMachineClient(adminCfg(fetch), spec);

    expect(result).toEqual({ clientId: 'new-id', clientSecret: 'SECRET-NEW-XYZ', created: true });
    expect(calls).toHaveLength(2);
    const post = calls[1];
    expect(post.method).toBe('POST');
    expect(post.url).toBe(`${ADMIN_BASE}/admin/tenants/${TENANT_ID}/clients`);
    expect(post.headers.get('content-type')).toBe('application/json');
    expect(post.headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
    const body = post.body as Record<string, unknown>;
    expect(body.client_name).toBe('gateway-machine');
    expect(body.client_profile).toBe('web');
    expect(body.application_type).toBe('web');
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(body.grant_types).toEqual(['client_credentials']);
    expect(body.redirect_uris).toEqual([]);
    expect(body.response_types).toEqual([]);
    expect(body.access_token_audience).toBe('company');
    expect(body.access_token_custom_claims).toEqual(fixedClaimsFor('gateway', { ns: 'company', db: 'main' }));
    expect(typeof body.machine_token_ttl_seconds).toBe('number');
    expect(post.url).not.toContain('SECRET');
  });

  test('列表返回 401 映射为 unauthorized，403 映射为 forbidden', async () => {
    const unauthorized = fakeFetch(() => json(401, { error: 'unauthorized' }));
    const e1 = (await ensureMachineClient(adminCfg(unauthorized.fetch), spec).catch((e: unknown) => e)) as IdpError;
    expect(e1.code).toBe('unauthorized');
    expect(e1.status).toBe(401);

    const forbidden = fakeFetch((call) => (call.method === 'GET' ? json(200, { clients: [] }) : json(403, { error: 'forbidden' })));
    const e2 = (await ensureMachineClient(adminCfg(forbidden.fetch), spec).catch((e: unknown) => e)) as IdpError;
    expect(e2.code).toBe('forbidden');
    expect(e2.status).toBe(403);
  });

  test('POST 返回 409 映射为 conflict；400/404/502 分别映射', async () => {
    const cases: Array<[number, IdpError['code']]> = [
      [409, 'conflict'],
      [400, 'invalid'],
      [404, 'not_found'],
      [502, 'upstream_error'],
    ];
    for (const [status, code] of cases) {
      const { fetch } = fakeFetch((call) =>
        call.method === 'GET' ? json(200, { clients: [] }) : json(status, { error: 'x_error' }),
      );
      const err = (await ensureMachineClient(adminCfg(fetch), spec).catch((e: unknown) => e)) as IdpError;
      expect(err).toBeInstanceOf(IdpError);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
    }
  });

  test('错误信息不包含响应中的 client_secret 或管理令牌', async () => {
    const { fetch } = fakeFetch((call) =>
      call.method === 'GET'
        ? json(200, { clients: [] })
        : json(400, { error: 'invalid_client_metadata', client_secret: 'LEAKED-SECRET-ABC', token: ADMIN_TOKEN }),
    );
    const err = (await ensureMachineClient(adminCfg(fetch), spec).catch((e: unknown) => e)) as IdpError;
    expect(err.message).not.toContain('LEAKED-SECRET-ABC');
    expect(err.message).not.toContain(ADMIN_TOKEN);
  });
});

describe('admin: resetClientSecret', () => {
  test('POST .../secret/reset，clientId 经 encodeURIComponent，返回新 secret', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { client_id: 'a/b', client_secret: 'RESET-SECRET-1' }));
    const result = await resetClientSecret(adminCfg(fetch), 'a/b');

    expect(result).toEqual({ clientId: 'a/b', clientSecret: 'RESET-SECRET-1' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${ADMIN_BASE}/admin/tenants/${TENANT_ID}/clients/a%2Fb/secret/reset`);
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
  });
});

describe('admin: agent users', () => {
  test('按规范化 email 命中已有 agent 用户：不创建', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, {
        users: [{ id: 'user-1', email: 'bot@example.com', display_name: 'Bot', status: 'active', kind: 'agent' }],
      }),
    );
    const result = await ensureAgentUser(adminCfg(fetch), { email: '  Bot@Example.COM ', displayName: 'Bot' });

    expect(result).toEqual({ userId: 'user-1', created: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${ADMIN_BASE}/admin/tenants/${TENANT_ID}/users?kind=agent`);
  });

  test('未命中则 POST，body 含 kind:"agent" 与规范化 email', async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.method === 'GET') return json(200, { users: [] });
      return json(201, {
        user: { id: 'user-new', email: 'new-bot@example.com', kind: 'agent', status: 'active' },
        invitation_token: null,
        activation_url: null,
      });
    });
    const result = await ensureAgentUser(adminCfg(fetch), { email: ' New-Bot@Example.com ', displayName: ' 新机器人 ' });

    expect(result).toEqual({ userId: 'user-new', created: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe(`${ADMIN_BASE}/admin/tenants/${TENANT_ID}/users`);
    expect(calls[1].body).toEqual({ email: 'new-bot@example.com', display_name: '新机器人', kind: 'agent' });
  });

  test('开户 409 映射为 conflict', async () => {
    const { fetch } = fakeFetch((call) => (call.method === 'GET' ? json(200, { users: [] }) : json(409, { error: 'conflict' })));
    const err = (await ensureAgentUser(adminCfg(fetch), { email: 'a@b.co', displayName: 'A' }).catch((e: unknown) => e)) as IdpError;
    expect(err.code).toBe('conflict');
  });

  test('listAgentUsers 映射字段并带 kind=agent 过滤', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, {
        users: [{ id: 'u1', email: 'a@b.co', display_name: 'A', status: 'active', kind: 'agent' }],
      }),
    );
    const users = await listAgentUsers(adminCfg(fetch));

    expect(users).toEqual([{ id: 'u1', email: 'a@b.co', displayName: 'A', status: 'active' }]);
    expect(calls[0].url).toContain('kind=agent');
  });
});

describe('machine token: fetchMachineToken', () => {
  const tokenUrl = `${ADMIN_BASE}/t/company/token`;

  test('表单 grant_type=client_credentials，Basic 认证头正确，secret 不进入 URL', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, { access_token: 'AT-1', token_type: 'Bearer', expires_in: 600, scope: '' }),
    );
    const result = await fetchMachineToken(
      { tokenUrl, clientId: 'cid-1', clientSecret: 'sec-1', fetch },
      () => 1000,
    );

    expect(result).toEqual({ accessToken: 'AT-1', expiresAt: 1000 + 600 - 60 });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(tokenUrl);
    expect(calls[0].url).not.toContain('sec-1');
    expect(calls[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(calls[0].rawBody).toBe('grant_type=client_credentials');
    expect(calls[0].headers.get('authorization')).toBe(`Basic ${base64Utf8('cid-1:sec-1')}`);
    expect(calls[0].headers.get('authorization')).toBe(`Basic ${btoa('cid-1:sec-1')}`);
  });

  test('expires_in 不足 120 秒时至少保留 1 秒有效期', async () => {
    const { fetch } = fakeFetch(() => json(200, { access_token: 'AT-2', token_type: 'Bearer', expires_in: 30 }));
    const result = await fetchMachineToken({ tokenUrl, clientId: 'c', clientSecret: 's', fetch }, () => 500);
    expect(result.expiresAt).toBe(501);
  });

  test('端点返回 401 时抛出 unauthorized，错误信息不含 secret', async () => {
    const { fetch } = fakeFetch(() =>
      json(401, { error: 'invalid_client', error_description: 'bad secret SECRET-LEAK-9' }),
    );
    const err = (await fetchMachineToken(
      { tokenUrl, clientId: 'c', clientSecret: 'SECRET-LEAK-9', fetch },
    ).catch((e: unknown) => e)) as IdpError;

    expect(err).toBeInstanceOf(IdpError);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toContain('invalid_client');
    expect(err.message).not.toContain('SECRET-LEAK-9');
  });

  test('响应缺少 access_token 时抛出 upstream_error', async () => {
    const { fetch } = fakeFetch(() => json(200, { token_type: 'Bearer', expires_in: 600 }));
    const err = (await fetchMachineToken({ tokenUrl, clientId: 'c', clientSecret: 's', fetch }).catch(
      (e: unknown) => e,
    )) as IdpError;
    expect(err.code).toBe('upstream_error');
  });
});

describe('machine token: createMachineTokenCache', () => {
  test('未过期时命中缓存，不重复请求', async () => {
    let loads = 0;
    let t = 1000;
    const get = createMachineTokenCache(
      async () => {
        loads += 1;
        return { accessToken: `tok-${loads}`, expiresAt: 2000 };
      },
      () => t,
    );
    expect(await get()).toBe('tok-1');
    t = 1500;
    expect(await get()).toBe('tok-1');
    expect(loads).toBe(1);
  });

  test('过期后重新获取', async () => {
    let loads = 0;
    let t = 1000;
    const get = createMachineTokenCache(
      async () => {
        loads += 1;
        return { accessToken: `tok-${loads}`, expiresAt: 2000 };
      },
      () => t,
    );
    expect(await get()).toBe('tok-1');
    t = 2000;
    expect(await get()).toBe('tok-2');
    expect(loads).toBe(2);
  });

  test('并发调用合并为一次 loader 调用', async () => {
    let loads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = createMachineTokenCache(
      async () => {
        loads += 1;
        await gate;
        return { accessToken: 'shared', expiresAt: 9999 };
      },
      () => 0,
    );
    const pending = Promise.all([get(), get(), get(), get(), get()]);
    release?.();
    const tokens = await pending;
    expect(tokens).toEqual(['shared', 'shared', 'shared', 'shared', 'shared']);
    expect(loads).toBe(1);
  });

  test('loader 失败不缓存，下次调用重新获取', async () => {
    let loads = 0;
    const get = createMachineTokenCache(
      async () => {
        loads += 1;
        if (loads === 1) throw new Error('网络失败');
        return { accessToken: 'ok-after-retry', expiresAt: 9999 };
      },
      () => 0,
    );
    await expect(get()).rejects.toThrow('网络失败');
    expect(await get()).toBe('ok-after-retry');
    expect(loads).toBe(2);
  });
});

describe('claims and client spec', () => {
  const roles: Array<[MachineRole, string, string[]]> = [
    ['gateway', 'gateway', ['Editor']],
    ['viewer', 'viewer', ['Viewer']],
    ['automation', 'automation', ['Editor']],
    ['runner', 'runner', ['Editor']],
    ['migrator', 'migrator', ['Owner']],
    ['agentClaims', 'agent', ['Editor']],
  ];

  test('MACHINE_ROLE_CLAIMS 与约定一致', () => {
    for (const [role, ac, rl] of roles) {
      expect(MACHINE_ROLE_CLAIMS[role]).toEqual({ ac, rl });
    }
  });

  test('fixedClaimsFor：ac/ns/db 为字符串，rl 为 json 数组字符串', () => {
    for (const [role, ac, rl] of roles) {
      const claims = fixedClaimsFor(role, { ns: 'company', db: 'main' });
      const byName = Object.fromEntries(claims.map((c) => [c.claim_name, c]));

      expect(byName.ac).toEqual({ claim_name: 'ac', source_type: 'fixed', fixed_value: ac });
      expect(byName.ns).toEqual({ claim_name: 'ns', source_type: 'fixed', fixed_value: 'company' });
      expect(byName.db).toEqual({ claim_name: 'db', source_type: 'fixed', fixed_value: 'main' });
      expect(byName.rl).toEqual({
        claim_name: 'rl',
        source_type: 'fixed',
        fixed_value: JSON.stringify(rl),
        value_type: 'json',
      });
      expect(JSON.parse(byName.rl.fixed_value)).toEqual(rl);
    }
  });

  test('固定声明不含保留声明名，ac/ns/db/rl 不是保留名', () => {
    for (const [role] of roles) {
      for (const claim of fixedClaimsFor(role, { ns: 'company', db: 'main' })) {
        expect(RESERVED_CLAIM_NAMES.has(claim.claim_name)).toBe(false);
      }
    }
    for (const name of ['ac', 'ns', 'db', 'rl']) {
      expect(RESERVED_CLAIM_NAMES.has(name)).toBe(false);
    }
    for (const name of ['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'jti', 'scope', 'client_id', 'nonce', 'act', 'task']) {
      expect(RESERVED_CLAIM_NAMES.has(name)).toBe(true);
    }
  });

  test('fixedClaimsFor 拒绝空 ns/db', () => {
    expect(() => fixedClaimsFor('gateway', { ns: '', db: 'main' })).toThrow();
    expect(() => fixedClaimsFor('gateway', { ns: 'company', db: ' ' })).toThrow();
  });

  test('machineClientSpec：受众为 company，grant 与认证方式正确', () => {
    expect(CLIENT_TOKEN_AUDIENCE).toBe('company');
    const spec = machineClientSpec('gateway', { clientName: 'gw', ns: 'company', db: 'main' });

    expect(spec.access_token_audience).toBe('company');
    expect(spec.grant_types).toEqual(['client_credentials']);
    expect(spec.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(spec.client_profile).toBe('web');
    expect(spec.application_type).toBe('web');
    expect(spec.redirect_uris).toEqual([]);
    expect(spec.response_types).toEqual([]);
    expect(spec.access_token_custom_claims.every((c) => c.source_type === 'fixed')).toBe(true);
    expect(spec.agent_token_exchange_enabled).toBeUndefined();
    expect(spec.agent_claim_source_client_id).toBeUndefined();
  });

  test('machineClientSpec：各角色的 rl 与 ac 通过固定声明下发', () => {
    for (const [role, ac, rl] of roles) {
      const spec = machineClientSpec(role, { clientName: `c-${role}`, ns: 'company', db: 'main' });
      const ac1 = spec.access_token_custom_claims.find((c) => c.claim_name === 'ac');
      const rl1 = spec.access_token_custom_claims.find((c) => c.claim_name === 'rl');
      expect(ac1?.fixed_value).toBe(ac);
      expect(rl1?.value_type).toBe('json');
      expect(JSON.parse(rl1?.fixed_value ?? 'null')).toEqual(rl);
    }
  });

  test('machineClientSpec：TTL 默认值在 60-900 秒内，越界抛错', () => {
    const spec = machineClientSpec('viewer', { clientName: 'v', ns: 'company', db: 'main' });
    expect(spec.machine_token_ttl_seconds).toBeGreaterThanOrEqual(60);
    expect(spec.machine_token_ttl_seconds).toBeLessThanOrEqual(900);
    expect(() => machineClientSpec('viewer', { clientName: 'v', ns: 'company', db: 'main', ttlSeconds: 59 })).toThrow();
    expect(() => machineClientSpec('viewer', { clientName: 'v', ns: 'company', db: 'main', ttlSeconds: 901 })).toThrow();
    expect(
      machineClientSpec('viewer', { clientName: 'v', ns: 'company', db: 'main', ttlSeconds: 900 }).machine_token_ttl_seconds,
    ).toBe(900);
  });

  test('machineClientSpec：可选的 agent 交换字段', () => {
    const spec = machineClientSpec('agentClaims', {
      clientName: 'agent-src',
      ns: 'company',
      db: 'main',
      allowAgentExchange: true,
      agentClaimSourceClientId: 'src-client-id',
    });
    expect(spec.agent_token_exchange_enabled).toBe(true);
    expect(spec.agent_claim_source_client_id).toBe('src-client-id');
  });
});
