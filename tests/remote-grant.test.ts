import { describe, expect, test } from 'bun:test';
import { issueRemoteGrant, listRemoteGrants, revokeRemoteGrant, remoteGrantUrl, validateRemoteBlock, dbWsUrl } from '../src/ops/remote-grant.ts';
import { sha256Base64Url } from '../src/ops/idp-principals.ts';
import type { D1Client } from '../src/ops/d1.ts';
import type { BrokerConfig } from '../src/ops/config.ts';

const cfg: BrokerConfig = {
  roles: ['qa'],
  idp: { issuer: 'https://o.example.test/t/ck', clientId: 'web_client', audience: 'aud-product', redirectUri: 'r', scope: 's', ops: { clientId: 'ops_client', audience: 'aud-ops', redirectUri: 'r' } },
  product: { url: 'https://l.example.test' },
  accounts: { prefix: 'qa-ops-', emailDomain: 'ops.example.test', workspacePrefix: 'qa-' },
  d1: { tenantId: 'tenant_1', databaseId: 'db_1' },
  data: { url: 'https://data.example.test', namespace: 'main' },
  limits: { workspacesPerDay: 5, accountsPerDay: 5 },
  remote: { clientId: 'remote_client', testManagerAlias: 'QA_MGR' },
};

function fakeD1(seed: { match: string; rows?: Record<string, unknown>[] }[] = []) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const d1: D1Client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      for (const rule of seed) if (sql.includes(rule.match)) return (rule.rows ?? []) as never[];
      return [] as never[];
    },
  };
  return { d1, queries };
}

function fakeProduct(handlers: { match: string; status?: number; body?: unknown }[]) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method, path: url.pathname, body });
    const hit = handlers.find((h) => url.pathname.includes(h.match));
    return new Response(JSON.stringify(hit?.body ?? { workspaces: [] }), { status: hit?.status ?? 200 });
  };
  return { fetch, calls };
}

const NOW = Date.parse('2026-11-10T00:00:00Z');
const deps = (over: Record<string, unknown> = {}) => ({
  now: () => NOW,
  randomCode: () => 'fixedcode1234567890fixedcode1234567890=='.slice(0, 43),
  operatorToken: async () => 'ops_tok',
  customerToken: async () => 'cust_tok',
  audit: async () => undefined,
  ...over,
});

describe('validateRemoteBlock', () => {
  test('rejects missing fields and out-of-range ttl', () => {
    expect(() => validateRemoteBlock({})).toThrow();
    expect(() => validateRemoteBlock({ clientId: 'c' })).toThrow();
    expect(() => validateRemoteBlock({ clientId: 'c', testManagerAlias: 'a', codeTtlHours: 200 })).toThrow();
    expect(validateRemoteBlock({ clientId: 'c', testManagerAlias: 'a' }).codeTtlHours).toBe(168);
  });
});

describe('issueRemoteGrant', () => {
  test('happy path: writes expires_at/test_origin, test-subject PUT, workspace, grant row without raw code, url parts encoded', async () => {
    const { d1, queries } = fakeD1([{ match: 'FROM users', rows: [{ id: 'u_1', expires_at: '2026-11-20T00:00:00.000Z' }] }]);
    const { fetch, calls } = fakeProduct([]);
    const audits: string[] = [];
    const result = await issueRemoteGrant(
      deps({ d1, fetch, audit: async (_a: string, e: string) => { audits.push(e); } }),
      { cfg, taskId: 'task_abcdef123', alias: 'QA_X', days: 30, content: true },
    );
    expect(result.grantId).toMatch(/^rg_/);
    expect(result.workspaceSlug).toBe('qa-qa-x-task_abc');
    expect(result.subject).toBe('u_1');
    // grant 行只存 hash
    const insert = queries.find((q) => q.sql.includes('INSERT INTO remote_grants'));
    expect(insert).toBeDefined();
    const hash = await sha256Base64Url('fixedcode1234567890fixedcode1234567890=='.slice(0, 43));
    expect(insert!.params[4]).toBe(hash);
    expect(JSON.stringify(insert!.params)).not.toContain('fixedcode');
    // url 组成
    expect(result.url).toContain('https://o.example.test/t/ck/remote#code=');
    expect(result.url).toContain('client_id=remote_client');
    expect(result.url).toContain('api=https%3A%2F%2Fl.example.test');
    expect(result.url).toContain('aud=aud-product');
    expect(result.url).toContain('ops_aud=aud-ops');
    expect(result.url).toContain('db_url=wss%3A%2F%2Fdata.example.test%2Frpc');
    // 顺序：test-subject PUT 在 workspace POST 之前
    const putIdx = calls.findIndex((c) => c.path.includes('test-subjects'));
    const wsIdx = calls.findIndex((c) => c.method === 'POST' && c.path.includes('workspaces'));
    expect(putIdx).toBeGreaterThanOrEqual(0);
    expect(wsIdx).toBeGreaterThan(putIdx);
    // 审计不含码
    expect(audits[0]).not.toContain('fixedcode');
    expect(audits[0]).toContain(result.grantId);
  });

  test('rejects a formal (expires_at NULL) existing account', async () => {
    const { d1 } = fakeD1([{ match: 'FROM users', rows: [{ id: 'u_f', expires_at: null }] }]);
    const { fetch } = fakeProduct([]);
    // expires_at 为 null 的现有账号 → conflict。注意种子行 expires_at 即 NULL。
    await expect(issueRemoteGrant(deps({ d1, fetch }), { cfg, taskId: 't', alias: 'QA_F' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  test('extends existing test account expiry to max(current, requested) capped at 31 days', async () => {
    const later = '2026-12-01T00:00:00.000Z'; // > now+30d? now=11-10, +30d=12-10 → max=12-10 <31d cap
    const { d1, queries } = fakeD1([{ match: 'FROM users', rows: [{ id: 'u_2', expires_at: later }] }]);
    const { fetch } = fakeProduct([]);
    await issueRemoteGrant(deps({ d1, fetch }), { cfg, taskId: 't2', alias: 'QA_Y', days: 5 });
    const upd = queries.find((q) => q.sql.includes('UPDATE users SET expires_at'));
    expect(upd!.params[0]).toBe(later); // 保留更晚现值
  });

  test('existing test account with later expiry keeps three expiry fields consistent', async () => {
    const later = '2026-12-01T00:00:00.000Z';
    const { d1, queries } = fakeD1([{ match: 'FROM users', rows: [{ id: 'u_2', expires_at: later }] }]);
    const { fetch, calls } = fakeProduct([]);
    const result = await issueRemoteGrant(
      deps({ d1, fetch }),
      { cfg, taskId: 't9', alias: 'QA_Y', days: 5 },
    );
    expect(result.expiresAt).toBe(later);
    const putBody = calls.find((c) => c.path.includes('test-subjects'))?.body as { expiresAt?: string };
    expect(putBody.expiresAt).toBe(later);
    const insert = queries.find((q) => q.sql.includes('INSERT INTO remote_grants'));
    expect(insert!.params[8]).toBe(later); // expires_at
  });

  test('rejects days outside 1..31 and missing remote config', async () => {
    const { d1 } = fakeD1();
    const { fetch } = fakeProduct([]);
    await expect(issueRemoteGrant(deps({ d1, fetch }), { cfg, taskId: 't', alias: 'QA_Z', days: 60 })).rejects.toThrow();
    const noRemote = { ...cfg, remote: undefined };
    await expect(issueRemoteGrant(deps({ d1, fetch }), { cfg: noRemote, taskId: 't', alias: 'QA_Z' })).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('revokeRemoteGrant', () => {
  test('revokes active grants and purges test subject + user expiry when requested', async () => {
    const { d1, queries } = fakeD1([
      { match: "SET status = 'revoked'", rows: [{ id: 'rg_1', user_id: 'u_1' }] },
    ]);
    const { fetch, calls } = fakeProduct([]);
    const result = await revokeRemoteGrant(deps({ d1, fetch }), { cfg, grantId: 'rg_1', purge: true });
    expect(result.revoked).toBe(1);
    expect(result.purged).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path.includes('test-subjects'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('UPDATE users SET expires_at'))).toBe(true);
  });
});

describe('listRemoteGrants + url helpers', () => {
  test('list never selects code_hash', async () => {
    const { d1, queries } = fakeD1([{ match: 'FROM remote_grants', rows: [] }]);
    await listRemoteGrants({ d1 }, { cfg });
    expect(queries[0]!.sql).not.toContain('code_hash');
  });
  test('dbWsUrl derives wss rpc and url helpers encode', () => {
    expect(dbWsUrl(cfg)).toBe('wss://data.example.test/rpc');
    expect(remoteGrantUrl(cfg, 'c#x', false)).toContain('code=c%23x');
  });
});
