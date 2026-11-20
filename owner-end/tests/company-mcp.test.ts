/**
 * 公司 MCP 第一期（只读工具）：验签、主体登记、任务绑定、白名单与审计。
 * 密钥用本地密钥集（注入 keys），库会话用脚本化替身（仿照 gateway 测试），不访问网络、不读环境。
 */
import { describe, expect, test } from 'bun:test';
import { RecordId, type Surreal } from 'surrealdb';
import {
  ISSUER, fakeDb, fakeSessions, keyFixture, signToken, testConfig, testEnv,
  type FakeCall, type KeyFixture,
} from './_support.ts';
import worker from '../src/worker.ts';
import { handleCompanyMcp, verifyMcpToken, type McpDeps } from '../src/mcp.ts';
import { authenticate } from '../src/auth/caller.ts';
import { HARD_OWNER_ONLY, matchesCommand } from '../../src/command-guard.ts';

const ORIGIN = 'https://company.test.invalid';
const RESOURCE = `${ORIGIN}/api/mcp`;
const SUB = 'devin-cloud-sub';
const EMPLOYEE = 'eng-1';
const NOW = new Date('2030-01-01T00:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const LEASE = NOW_SECONDS + 3600;

const cfg = testConfig();

/** 登记一条主体：sub + 允许的员工 provider。 */
const PRINCIPAL = { sub: SUB, providers: ['devin-cloud'], label: 'Devin Cloud', enabled: true };

interface DbShape {
  principals?: unknown[];
  task?: Record<string, unknown> | null;
  employee?: Record<string, unknown> | null;
  /** query 响应：按 SQL 文本特征匹配。 */
  responses?: Array<[match: string, rows: unknown[]]>;
}

function mcpDb(shape: DbShape) {
  const { db, calls } = fakeDb((sql, vars) => {
    if (sql.includes('FROM $record') && sql.includes('principals')) return [{ principals: shape.principals ?? [] }];
    if (sql.includes('FROM $task')) {
      const t = shape.task;
      return t ? [{ current_employee: t.current_employee ?? null, lease_expires_at: t.lease_expires_at ?? null }] : [];
    }
    if (sql.includes('FROM protected_command')) return [];
    if (sql.includes('FROM agent_policy')) return [];
    if (sql.includes('FROM employee WHERE id IN')) return shape.employee ? [{ id: { id: EMPLOYEE }, provider: shape.employee.provider }] : [];
    if (sql.includes('FROM task WHERE')) return shape.responses?.find(([m]) => sql.includes(m))?.[1] ?? [];
    if (sql.includes('FROM $job')) return shape.responses?.find(([m]) => sql.includes('FROM $job'))?.[1] ?? [];
    for (const [match, rows] of shape.responses ?? []) if (sql.includes(match)) return rows;
    return [];
  });
  (db as { select?: unknown }).select = async (id: RecordId) => {
    const tb = String(id).split(':', 1)[0];
    if (tb === 'task') return shape.task ?? null;
    if (tb === 'employee') return shape.employee ?? null;
    return null;
  };
  return { db, calls };
}

function deps(db: Surreal, extra: Partial<McpDeps> = {}): McpDeps {
  return { cfg, sessions: fakeSessions(db), keys: KEY.keys, now: () => NOW, waitMs: 0, ...extra };
}

let KEY: KeyFixture;

/** 有效 MCP 令牌：issuer=测试 IdP、audience=资源地址、scope 含 company.work。 */
async function mcpToken(claims: Record<string, unknown> = {}, audience = RESOURCE): Promise<string> {
  return signToken(KEY, { sub: SUB, ac: 'agent', scope: 'openid company.work', task: 't1', ...claims }, { audience });
}

function rpc(method: string, params?: unknown, id = 1): Request {
  return new Request(`${ORIGIN}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

function authed(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${token}`);
  return new Request(request, { headers });
}

async function callTool(token: string, db: Surreal, name: string, args: Record<string, unknown>, extra: Partial<McpDeps> = {}) {
  const response = await handleCompanyMcp(authed(rpc('tools/call', { name, arguments: args }), token), deps(db, extra));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** tools/call 返回的 result 体（结构化错误或成功值）。 */
function resultOf(body: Record<string, unknown>) {
  return (body as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } }).result;
}

const LEASED_TASK = {
  title: '修理公司 MCP', state: 'in_progress', project: { id: 'ops' },
  discipline: 'backend', executor_role: 'engineering',
  requirement: '把公司 MCP 跑通', acceptance_text: '工具可查询',
  worktree: { branch: 'task/t1-mcp', path: '/home/secret/worktree' },
  current_employee: EMPLOYEE, lease_expires_at: LEASE,
};

const DENIED_AUDITS = (calls: FakeCall[]) =>
  calls.filter((call) => call.sql.includes('CREATE ops_audit') && call.vars.outcome === 'denied');

describe('公司 MCP 验签与元数据', () => {
  test('无 Bearer / 签名错 / issuer 错 / 控制台 audience / 缺 company.work / 过期 → 401 且带挑战头', async () => {
    KEY = await keyFixture();
    const { db } = mcpDb({});

    const unauthenticated = await handleCompanyMcp(rpc('tools/list'), deps(db));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/api/mcp/.well-known/oauth-protected-resource"`);

    const attacker = await keyFixture('other');
    const wrongKey = await signToken(attacker, { sub: SUB, scope: 'openid company.work' }, { audience: RESOURCE });
    const wrongIssuer = await signToken(KEY, { sub: SUB, scope: 'openid company.work' }, { issuer: 'https://evil.test', audience: RESOURCE });
    const consoleAudience = await mcpToken({}, cfg.idp.audience);
    const noScope = await mcpToken({ scope: 'openid' });
    const expired = await signToken(KEY, { sub: SUB, scope: 'openid company.work' }, { audience: RESOURCE, expiresIn: Math.floor(Date.now() / 1000) - 60 });

    for (const token of [wrongKey, wrongIssuer, consoleAudience, noScope, expired]) {
      const response = await handleCompanyMcp(authed(rpc('tools/list'), token), deps(db));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    }
  });

  test('verifyMcpToken 返回 sub、scopes、exp', async () => {
    const token = await mcpToken();
    const verified = await verifyMcpToken(token, cfg, RESOURCE, KEY.keys);
    expect(verified.sub).toBe(SUB);
    expect(verified.scopes).toContain('company.work');
    expect(verified.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await expect(verifyMcpToken(token, cfg, 'https://other.test/api/mcp', KEY.keys)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  test('metadata 端点返回正确 resource 与 scopes', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/mcp/.well-known/oauth-protected-resource`), testEnv());
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual(['openid', 'company.work']);
    expect(body.bearer_methods_supported).toEqual(['header']);
  });

  test('MCP 令牌打 /api/cmd 的鉴权路径（authenticate）被拒', async () => {
    const token = await mcpToken();
    await expect(authenticate(new Request(`${ORIGIN}/api/cmd`, { headers: { authorization: `Bearer ${token}` } }), cfg, KEY.keys))
      .rejects.toMatchObject({ code: 'unauthorized' });
  });

  test('mcp.principal.* 在 HARD_OWNER_ONLY：员工与 agent 令牌永远不能改登记', () => {
    expect(HARD_OWNER_ONLY.some((pattern) => matchesCommand(pattern, 'mcp.principal.set'))).toBe(true);
    expect(HARD_OWNER_ONLY.some((pattern) => matchesCommand(pattern, 'mcp.principal.list'))).toBe(true);
  });
});

describe('公司 MCP 工具', () => {
  const boundDb = (overrides: Partial<DbShape> = {}) => mcpDb({
    principals: [PRINCIPAL],
    task: LEASED_TASK,
    employee: { provider: 'devin-cloud' },
    ...overrides,
  });

  test('tools/list 恰好 5 个工具', async () => {
    const token = await mcpToken();
    const { db } = boundDb();
    const response = await handleCompanyMcp(authed(rpc('tools/list'), token), deps(db));
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { tools?: Array<{ name: string }> } };
    expect(body.result?.tools?.map((tool) => tool.name).sort()).toEqual(
      ['company_job', 'company_landscape', 'company_ops', 'task_context', 'task_current'].sort());
  });

  test('task_context 返回投影：分支/仓库/需求，不含本机路径与 secrets', async () => {
    const token = await mcpToken();
    const { db, calls } = boundDb({
      responses: [
        ['action IN $actions', [{ evidence: '提交说明', action: 'submit', at: 'x' }]],
        ['FROM project_env', []],
        ['FROM env_secret', []],
      ],
    });
    const { status, body } = await callTool(token, db, 'task_context', { taskId: 't1' });
    expect(status).toBe(200);
    const result = resultOf(body);
    expect(result?.isError).toBeFalsy();
    const value = result?.structuredContent as Record<string, unknown>;
    expect(value.taskId).toBe('t1');
    expect(value.branch).toBe('task/t1-mcp');
    expect(value.title).toBe('修理公司 MCP');
    expect(JSON.stringify(value)).not.toContain('/home/secret');
    expect(DENIED_AUDITS(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql.includes('CREATE ops_audit') && call.vars.outcome === 'ok' && call.vars.actor === EMPLOYEE)).toBe(true);
  });

  test('task_current 只列本身份任务', async () => {
    const token = await mcpToken();
    const { db } = boundDb({
      responses: [[
        'FROM task WHERE',
        [
          { id: { id: 't1' }, title: '我的', state: 'in_progress', project: { id: 'ops' }, current_employee: EMPLOYEE, lease_expires_at: LEASE },
          { id: { id: 't2' }, title: '别人的', state: 'in_progress', current_employee: 'eng-9', lease_expires_at: LEASE },
        ],
      ]],
    });
    const { body } = await callTool(token, db, 'task_current', {});
    const value = resultOf(body)?.structuredContent as { tasks: Array<{ taskId: string; leaseExpiresAt: number }> };
    expect(value.tasks.map((task) => task.taskId)).toEqual(['t1']);
    expect(value.tasks[0]?.leaseExpiresAt).toBe(LEASE);
  });

  test('company_landscape 结果与 landscape.get 一致', async () => {
    const token = await mcpToken();
    const { db } = boundDb();
    const { body } = await callTool(token, db, 'company_landscape', {});
    const value = resultOf(body)?.structuredContent as { landscape: { hosts: unknown[] }; observations: unknown[] };
    expect(value.landscape.hosts.length).toBeGreaterThan(0);
    expect(value.observations).toEqual([]);
  });

  test('company_ops 白名单工具入队：actor=current_employee、task 正确，超时 pending', async () => {
    const token = await mcpToken();
    const { db, calls } = boundDb();
    const { body } = await callTool(token, db, 'company_ops', { taskId: 't1', tool: 'ops_origin_status', args: {} });
    const value = resultOf(body)?.structuredContent as { pending?: boolean; jobId?: string };
    expect(value.pending).toBe(true);
    expect(value.jobId).toBeTypeOf('string');
    const enqueue = calls.find((call) => call.sql.includes('CREATE $job'));
    expect(enqueue).toBeDefined();
    expect(enqueue?.vars.content).toMatchObject({ command: 'ops_origin_status', actor_kind: 'agent', actor: EMPLOYEE });
  });

  test('未登记 sub 与 enabled=false → forbidden（令牌有效）', async () => {
    const token = await mcpToken();
    for (const principals of [[], [{ ...PRINCIPAL, enabled: false }]]) {
      const { db, calls } = boundDb({ principals });
      const { body } = await callTool(token, db, 'task_context', { taskId: 't1' });
      const result = resultOf(body);
      expect(result?.isError).toBe(true);
      expect((result?.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
      expect(DENIED_AUDITS(calls).length).toBeGreaterThan(0);
    }
  });

  test('任务无租约 / 租约过期 / 持有者 provider 不在主体 providers → forbidden', async () => {
    const token = await mcpToken();
    const cases: Array<Partial<DbShape>> = [
      { task: { ...LEASED_TASK, current_employee: null } },
      { task: { ...LEASED_TASK, lease_expires_at: NOW_SECONDS - 1 } },
      { employee: { provider: 'grok-bot' } },
      { employee: null },
      { task: null },
    ];
    for (const shape of cases) {
      const { db, calls } = boundDb(shape);
      const { body } = await callTool(token, db, 'task_context', { taskId: 't1' });
      const result = resultOf(body);
      expect(result?.isError).toBe(true);
      expect((result?.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
      expect(DENIED_AUDITS(calls).length).toBeGreaterThan(0);
    }
  });

  test('company_ops 非白名单工具 → forbidden 且不入队', async () => {
    const token = await mcpToken();
    for (const tool of ['ops_test_fixture_ready', 'host.exec']) {
      const { db, calls } = boundDb();
      const { body } = await callTool(token, db, 'company_ops', { taskId: 't1', tool });
      const result = resultOf(body);
      expect(result?.isError).toBe(true);
      expect((result?.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
      expect(calls.some((call) => call.sql.includes('CREATE $job'))).toBe(false);
      expect(DENIED_AUDITS(calls).length).toBeGreaterThan(0);
    }
  });

  test('company_job 查别的 provider 员工的作业 → forbidden', async () => {
    const token = await mcpToken();
    const { db, calls } = boundDb({
      employee: { provider: 'grok-bot' },
      responses: [['FROM $job', [{ actor_kind: 'agent', actor: 'eng-9', command: 'ops_origin_status', state: 'done' }]]],
    });
    const { body } = await callTool(token, db, 'company_job', { jobId: 'job-1' });
    const result = resultOf(body);
    expect(result?.isError).toBe(true);
    expect((result?.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
    expect(DENIED_AUDITS(calls).length).toBeGreaterThan(0);
  });

  test('company_job 查本身份员工的作业 → 返回详情', async () => {
    const token = await mcpToken();
    const { db } = boundDb({
      responses: [['FROM $job', [{
        id: 'job-1', actor_kind: 'agent', actor: EMPLOYEE, command: 'ops_origin_status', state: 'done', result: '{"ok":true}',
      }]]],
    });
    const { body } = await callTool(token, db, 'company_job', { jobId: 'job-1' });
    const value = resultOf(body)?.structuredContent as { command: string; actor: string };
    expect(value.command).toBe('ops_origin_status');
    expect(value.actor).toBe(EMPLOYEE);
  });
});
