import { describe, expect, test } from 'bun:test';
import { RecordId } from 'surrealdb';

import { CompanyError } from '../../src/core-errors.ts';
import { accountPath, cloudflareApi } from '../src/cf.ts';
import { auditSummary, listAudit } from '../src/audit.ts';
import { dbRead, dbWrite, readStatement } from '../src/db-commands.ts';
import { identityCommand } from '../src/idp-commands.ts';
import { fakeDb, json, scriptedFetch, testConfig } from './_support.ts';

/** 执行 fn，返回它抛出的 CompanyError 的错误码；未抛错或抛出非 CompanyError 时测试失败。 */
async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof CompanyError) return error.code;
    throw error;
  }
  throw new Error('应当抛出 CompanyError，实际没有抛错');
}

const ACCOUNT = 'acc123';
const CF_CFG = () => testConfig({ CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: 'tok' });
const CF_BASE = 'https://api.cloudflare.com/client/v4';

describe('cf.api 路径守卫（accountPath）', () => {
  test('合法的账号路径原样通过', () => {
    expect(accountPath(ACCOUNT, `/accounts/${ACCOUNT}/workers/scripts`)).toBe(`/accounts/${ACCOUNT}/workers/scripts`);
  });

  test('含 .. 段的路径被拒绝为 invalid', async () => {
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}/../../user/tokens`))).toBe('invalid');
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}/workers/..`))).toBe('invalid');
  });

  test('百分号编码的 %2e%2e 与 %2E%2E 被拒绝为 invalid', async () => {
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}/%2e%2e/user`))).toBe('invalid');
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}/%2E%2E/user`))).toBe('invalid');
  });

  test('. 段被拒绝为 invalid，空段与查询串也被拒绝', async () => {
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}/./workers`))).toBe('invalid');
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}/workers//x`))).toBe('invalid');
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}/workers?x=1`))).toBe('invalid');
  });

  test('不以 /accounts/<id>/ 开头的路径被拒绝为 forbidden', async () => {
    expect(await codeOf(() => accountPath(ACCOUNT, '/user/tokens'))).toBe('forbidden');
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/other/workers`))).toBe('forbidden');
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}`))).toBe('forbidden');
  });

  test('非字符串或超过 300 字符的路径为 invalid', async () => {
    expect(await codeOf(() => accountPath(ACCOUNT, undefined))).toBe('invalid');
    expect(await codeOf(() => accountPath(ACCOUNT, `/accounts/${ACCOUNT}/${'a'.repeat(300)}`))).toBe('invalid');
  });
});

describe('cf.api 调用（cloudflareApi）', () => {
  test('合法路径发往 Cloudflare API 并附带 Bearer 令牌', async () => {
    const { fetch, requests } = scriptedFetch([() => json({ success: true, result: [{ id: 'w1' }], errors: [] })]);
    const reply = await cloudflareApi(CF_CFG(), { method: 'GET', path: `/accounts/${ACCOUNT}/workers/scripts` }, fetch);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${CF_BASE}/accounts/${ACCOUNT}/workers/scripts`);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(reply).toEqual({ status: 200, success: true, result: [{ id: 'w1' }], errors: [] });
  });

  test('方法名大小写不敏感，并规范为大写', async () => {
    const { fetch, requests } = scriptedFetch([() => json({ success: true, result: null, errors: [] })]);
    await cloudflareApi(CF_CFG(), { method: 'get', path: `/accounts/${ACCOUNT}/workers/scripts` }, fetch);
    expect(requests[0]!.method).toBe('GET');
  });

  test('不在白名单内的方法被拒绝为 invalid，且不发请求', async () => {
    const { fetch, requests } = scriptedFetch([]);
    for (const method of ['TRACE', 'HEAD', 'OPTIONS', '']) {
      expect(await codeOf(() => cloudflareApi(CF_CFG(), { method, path: `/accounts/${ACCOUNT}/x` }, fetch))).toBe('invalid');
    }
    expect(requests).toHaveLength(0);
  });

  test('路径非法时不发请求', async () => {
    const { fetch, requests } = scriptedFetch([]);
    expect(await codeOf(() => cloudflareApi(CF_CFG(), { method: 'GET', path: `/accounts/${ACCOUNT}/%2e%2e/x` }, fetch))).toBe('invalid');
    expect(await codeOf(() => cloudflareApi(CF_CFG(), { method: 'GET', path: '/user/tokens' }, fetch))).toBe('forbidden');
    expect(requests).toHaveLength(0);
  });

  test('请求体超过 64 KB 被拒绝为 invalid，且不发请求', async () => {
    const { fetch, requests } = scriptedFetch([]);
    const body = { blob: 'a'.repeat(70 * 1024) };
    expect(await codeOf(() => cloudflareApi(CF_CFG(), { method: 'POST', path: `/accounts/${ACCOUNT}/x`, body }, fetch))).toBe('invalid');
    expect(requests).toHaveLength(0);
  });

  test('小请求体随 POST 发出，并带 JSON 内容类型', async () => {
    const { fetch, requests } = scriptedFetch([() => json({ success: true, result: { ok: 1 }, errors: [] })]);
    await cloudflareApi(CF_CFG(), { method: 'POST', path: `/accounts/${ACCOUNT}/x`, body: { name: 'n' } }, fetch);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers.get('content-type')).toBe('application/json');
    expect(await requests[0]!.text()).toBe('{"name":"n"}');
  });

  test('未配置 CF 时返回 not_configured，且不发请求', async () => {
    const { fetch, requests } = scriptedFetch([]);
    expect(await codeOf(() => cloudflareApi(testConfig({}), { method: 'GET', path: `/accounts/${ACCOUNT}/x` }, fetch))).toBe('not_configured');
    expect(requests).toHaveLength(0);
  });
});

describe('idp.request 路径与参数守卫', () => {
  const IDP_CFG = () => testConfig({ IDP_ADMIN_TOKEN: 'admin-tok', IDP_TENANT_ID: 't1' });

  test('路径穿越与百分号编码被拒绝为 invalid，且不发请求', async () => {
    const { fetch, requests } = scriptedFetch([]);
    const paths = [
      '/admin/x/../y', '/admin/%2e%2e/y', '/admin/tenants%2f', '/admin/%41', '/tenants', '/admin/a..b',
      // . 段、空段、末尾斜杠与查询串里的百分号编码：归一化后可能跳出 /admin，或让目标锁判错。
      '/admin/./service-principals', '/admin//tenants', '/admin/tenants/', '/admin/tenants/..', '/admin/tenants?x=%2e',
    ];
    for (const path of paths) {
      expect(await codeOf(() => identityCommand(IDP_CFG(), fakeDb().db, 'idp.request', { method: 'GET', path }, fetch))).toBe('invalid');
    }
    expect(requests).toHaveLength(0);
  });

  test('非白名单方法被拒绝为 invalid', async () => {
    const { fetch, requests } = scriptedFetch([]);
    expect(await codeOf(() => identityCommand(IDP_CFG(), fakeDb().db, 'idp.request', { method: 'PUT', path: '/admin/tenants' }, fetch))).toBe('invalid');
    expect(requests).toHaveLength(0);
  });

  test('合法的 /admin/tenants 以 GET 发出，并带管理令牌', async () => {
    const { fetch, requests } = scriptedFetch([() => json([{ id: 't1' }])]);
    const result = await identityCommand(IDP_CFG(), fakeDb().db, 'idp.request', { method: 'get', path: '/admin/tenants' }, fetch);

    expect(result).toEqual([{ id: 't1' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://o.test.invalid/admin/tenants');
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer admin-tok');
  });

  test('非对象的 body 被拒绝为 invalid', async () => {
    const { fetch, requests } = scriptedFetch([]);
    expect(await codeOf(() => identityCommand(IDP_CFG(), fakeDb().db, 'idp.request', { method: 'POST', path: '/admin/tenants', body: 'str' }, fetch))).toBe('invalid');
    expect(await codeOf(() => identityCommand(IDP_CFG(), fakeDb().db, 'idp.request', { method: 'POST', path: '/admin/tenants', body: null }, fetch))).toBe('invalid');
    expect(requests).toHaveLength(0);
  });

  test('未配置 IDP_ADMIN_TOKEN 时返回 not_configured，且不发请求', async () => {
    const { fetch, requests } = scriptedFetch([]);
    expect(await codeOf(() => identityCommand(testConfig({}), fakeDb().db, 'idp.request', { method: 'GET', path: '/admin/tenants' }, fetch))).toBe('not_configured');
    expect(requests).toHaveLength(0);
  });
});

describe('db.read 语句守卫（readStatement）', () => {
  test('单条 SELECT 通过，末尾分号被去掉', () => {
    expect(readStatement('SELECT * FROM employee')).toBe('SELECT * FROM employee');
    expect(readStatement('  select * from employee;  ')).toBe('select * from employee');
  });

  test('多语句（含中间分号）被拒绝为 invalid', () => {
    expect(() => readStatement('SELECT 1; DELETE x')).toThrow(CompanyError);
  });

  test('UPDATE、DELETE、DEFINE 被拒绝为 invalid', async () => {
    expect(await codeOf(() => readStatement('UPDATE employee SET x = 1'))).toBe('invalid');
    expect(await codeOf(() => readStatement('DELETE employee'))).toBe('invalid');
    expect(await codeOf(() => readStatement('DEFINE TABLE x'))).toBe('invalid');
  });

  test('包含 http:: 的语句被拒绝为 invalid', async () => {
    expect(await codeOf(() => readStatement('SELECT * FROM http::get("https://x.invalid")'))).toBe('invalid');
    expect(await codeOf(() => readStatement('SELECT HTTP::post("https://x.invalid") AS r'))).toBe('invalid');
  });

  test('超过 20000 字符被拒绝，恰好 20000 字符通过', async () => {
    const exact = `SELECT ${'a'.repeat(20000 - 7)}`;
    expect(exact.length).toBe(20000);
    expect(readStatement(exact)).toBe(exact);
    expect(await codeOf(() => readStatement(`${exact}a`))).toBe('invalid');
  });

  test('空字符串、纯空白与非字符串为 invalid', async () => {
    expect(await codeOf(() => readStatement(''))).toBe('invalid');
    expect(await codeOf(() => readStatement('   '))).toBe('invalid');
    expect(await codeOf(() => readStatement(undefined))).toBe('invalid');
  });
});

describe('db.read 与 db.write 执行', () => {
  test('dbRead 执行合法 SELECT，变量原样传入', async () => {
    const { db, calls } = fakeDb(() => [{ id: 'e1' }]);
    const result = await dbRead(db, { sql: 'SELECT * FROM employee WHERE id = $id', vars: { id: 'e1' } });

    expect(calls).toEqual([{ sql: 'SELECT * FROM employee WHERE id = $id', vars: { id: 'e1' } }]);
    expect(result.results).toEqual([[{ id: 'e1' }]]);
  });

  test('dbRead 对空 sql 返回 invalid，且不查询数据库', async () => {
    const { db, calls } = fakeDb();
    expect(await codeOf(() => dbRead(db, { sql: '' }))).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  test('dbRead 的 vars 非对象为 invalid', async () => {
    const { db, calls } = fakeDb();
    expect(await codeOf(() => dbRead(db, { sql: 'SELECT 1', vars: [1, 2] }))).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  test('dbWrite 不做语句限制，sql 原样交给 db.query', async () => {
    const { db, calls } = fakeDb();
    const sql = 'UPDATE employee SET disabled = $d; DELETE old_row;';
    await dbWrite(db, { sql, vars: { d: true } });

    expect(calls).toEqual([{ sql, vars: { d: true } }]);
  });

  test('dbWrite 对空 sql 与超长 sql 返回 invalid', async () => {
    const { db, calls } = fakeDb();
    expect(await codeOf(() => dbWrite(db, { sql: '  ' }))).toBe('invalid');
    expect(await codeOf(() => dbWrite(db, { sql: 'a'.repeat(20001) }))).toBe('invalid');
    expect(calls).toHaveLength(0);
  });
});

describe('审计一句话摘要（auditSummary）', () => {
  test('已登记命令只取登记的字段，空值不出现', () => {
    const summary = auditSummary('task.create', {
      title: '写测试',
      executorRole: 'dev',
      reviewerRole: '',
      type: null,
      extra: 'ignored',
    });
    expect(summary).toBe('task.create 标题=写测试 指派=dev');
  });

  test('未登记命令：敏感参数名（token、secret、password、passwd、authorization、verifier）不出现，值也不出现', () => {
    const summary = auditSummary('custom.do', {
      token: 'TOKEN-VALUE-123',
      client_secret: 'SECRET-VALUE-456',
      password: 'PW-VALUE-789',
      passwd: 'PASSWD-VALUE-000',
      authorization: 'Bearer AUTH-VALUE-111',
      code_verifier: 'VERIFIER-VALUE-222',
      note: 'hi',
    });
    expect(summary).toBe('custom.do note=hi');
    for (const secret of ['TOKEN-VALUE', 'SECRET-VALUE', 'PW-VALUE', 'PASSWD-VALUE', 'AUTH-VALUE', 'VERIFIER-VALUE']) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).not.toContain('token=');
    expect(summary).not.toContain('authorization=');
  });

  test('已登记命令的敏感字段不在摘要中（idp.request 不把 body 带入摘要）', () => {
    const summary = auditSummary('idp.request', { method: 'POST', path: '/admin/tenants', body: { token: 'BODY-SECRET-1' } });
    expect(summary).toBe('idp.request 方法=POST 路径=/admin/tenants');
    expect(summary).not.toContain('BODY-SECRET-1');
  });

  test('长文本按 80 个字符截断并加省略号', () => {
    const summary = auditSummary('instruct', { text: 'a'.repeat(200) });
    expect(summary).toBe(`instruct 内容=${'a'.repeat(80)}…`);
  });

  test('文本中的 JWT 形状内容被脱敏', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefgh';
    const summary = auditSummary('instruct', { text: `请使用 ${jwt} 登录` });
    expect(summary).not.toContain(jwt);
    expect(summary).toContain('[redacted]');
  });

  test('未登记命令最多取前 4 个非敏感参数，摘要长度不超过 500 字', () => {
    const input: Record<string, unknown> = {};
    for (let i = 1; i <= 6; i += 1) input[`k${i}`] = 'v'.repeat(300);
    const summary = auditSummary('custom.many', input);
    expect(summary.startsWith('custom.many k1=')).toBe(true);
    expect(summary).not.toContain('k5=');
    expect(summary.length).toBeLessThanOrEqual(500);
  });

  test('未知命令且无参数时返回可读字符串，不抛错', () => {
    expect(() => auditSummary('no.such.command', {})).not.toThrow();
    expect(auditSummary('no.such.command', {})).toBe('no.such.command');
    expect(auditSummary('no.such.command', { foo: null, bar: 3 })).toBe('no.such.command foo=null bar=3');
  });
});

describe('审计时间线（listAudit）', () => {
  const ROW = {
    at: '2026-01-02T03:04:05Z',
    actor_kind: 'agent',
    actor: 'a1',
    task: new RecordId('task', 'T1'),
    command: 'task.create',
    outcome: 'ok',
    reason: null,
    summary: 'task.create 标题=x',
  };

  test('缺省 limit 为 50，超过 200 的 limit 被限制为 200，非法值回到缺省', async () => {
    const { db, calls } = fakeDb();
    await listAudit(db, {});
    await listAudit(db, { limit: 500 });
    await listAudit(db, { limit: 0 });
    await listAudit(db, { limit: 'abc' });
    expect(calls.map((c) => c.vars.limit)).toEqual([50, 200, 1, 50]);
  });

  test('SQL 按 at 降序并带 LIMIT $limit', async () => {
    const { db, calls } = fakeDb();
    await listAudit(db, {});
    expect(calls[0]!.sql).toContain('FROM ops_audit');
    expect(calls[0]!.sql).toContain('ORDER BY at DESC');
    expect(calls[0]!.sql).toContain('LIMIT $limit');
    expect(calls[0]!.sql).not.toContain('WHERE');
  });

  test('按员工（agent）筛选：WHERE 限定 actor_kind 与 actor', async () => {
    const { db, calls } = fakeDb();
    await listAudit(db, { agent: 'a1' });
    expect(calls[0]!.sql).toContain("WHERE actor_kind = 'agent' AND actor = $agent");
    expect(calls[0]!.vars.agent).toBe('a1');
  });

  test('按任务筛选：任务编号转为 RecordId', async () => {
    const { db, calls } = fakeDb();
    await listAudit(db, { task: 'T1' });
    expect(calls[0]!.sql).toContain('WHERE task = $task');
    const task = calls[0]!.vars.task;
    expect(task).toBeInstanceOf(RecordId);
    expect((task as RecordId).id).toBe('T1');
  });

  test('按命令筛选，多个条件以 AND 连接', async () => {
    const { db, calls } = fakeDb();
    await listAudit(db, { agent: 'a1', task: 'T1', command: 'task.create' });
    expect(calls[0]!.sql).toContain(
      "WHERE actor_kind = 'agent' AND actor = $agent AND task = $task AND command = $command",
    );
    expect(calls[0]!.vars.command).toBe('task.create');
  });

  test('超过长度上限的筛选值被拒绝为 invalid', async () => {
    const { db, calls } = fakeDb();
    expect(await codeOf(() => listAudit(db, { agent: 'x'.repeat(65) }))).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  test('返回的记录形状为 AuditView，缺失值为 null', async () => {
    const { db } = fakeDb(() => [ROW, { actor_kind: 'human', actor: 'boss', command: 'guard.protect', outcome: 'denied', reason: 'x' }]);
    const { audit } = await listAudit(db, {});

    expect(audit).toEqual([
      {
        at: '2026-01-02T03:04:05.000Z',
        actorKind: 'agent',
        actor: 'a1',
        task: 'T1',
        command: 'task.create',
        outcome: 'ok',
        reason: null,
        summary: 'task.create 标题=x',
      },
      {
        at: null,
        actorKind: 'human',
        actor: 'boss',
        task: null,
        command: 'guard.protect',
        outcome: 'denied',
        reason: 'x',
        summary: null,
      },
    ]);
  });
});
