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
import { runOwnerApi } from '../src/commands.ts';

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
    // 预算扣次与写结论的条件 UPDATE：默认视作命中（返回任务行并回写计数/结论）；用例可用
    // 'SET mcp_ops_used' / 'SET mcp_outcome' 响应把它改成未命中（[] → 重试后 conflict/租约已变化）。
    if (sql.includes('SET mcp_ops_used')) {
      const hit = shape.responses?.find(([m]) => sql.includes(m))?.[1] ?? [{ ok: true }];
      // 克隆回写，避免把扣次漏进共享的 LEASED_TASK 夹具。
      if (hit.length && shape.task) shape.task = { ...shape.task, mcp_ops_used: vars.next };
      return hit;
    }
    if (sql.includes('SET mcp_outcome')) {
      const hit = shape.responses?.find(([m]) => sql.includes(m))?.[1] ?? [{ ok: true }];
      if (hit.length && shape.task) shape.task = { ...shape.task, mcp_outcome: vars.o };
      return hit;
    }
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
  title: '修理公司 MCP', state: 'doing', project: { id: 'ops' },
  discipline: 'backend', executor_role: 'engineering',
  requirement: '把公司 MCP 跑通', acceptance_text: '工具可查询',
  worktree: { branch: 'task/t1-mcp', path: '/home/secret/worktree' },
  current_employee: EMPLOYEE, lease_expires_at: LEASE,
  delivery_id: 'del-1', fence: 3,
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

  test('tools/list 恰好 8 个工具', async () => {
    const token = await mcpToken();
    const { db } = boundDb();
    const response = await handleCompanyMcp(authed(rpc('tools/list'), token), deps(db));
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { tools?: Array<{ name: string }> } };
    expect(body.result?.tools?.map((tool) => tool.name).sort()).toEqual(
      ['company_job', 'company_landscape', 'company_ops', 'task_block', 'task_context', 'task_current', 'task_review', 'task_submit'].sort());
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

  test('company_ops 白名单扩展：ops_origin_logs 与 ops_health 可入队作业', async () => {
    const token = await mcpToken();
    for (const tool of ['ops_origin_logs', 'ops_health']) {
      const { db, calls } = boundDb();
      const { body } = await callTool(token, db, 'company_ops', { taskId: 't1', tool, args: {} });
      const value = resultOf(body)?.structuredContent as { pending?: boolean; jobId?: string };
      expect(value.pending, tool).toBe(true);
      const enqueue = calls.find((call) => call.sql.includes('CREATE $job'));
      expect(enqueue?.vars.content).toMatchObject({ command: tool, actor_kind: 'agent', actor: EMPLOYEE });
    }
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

  test('company_job 别 provider 员工即使持有有效租约 → 仍 forbidden 且写 denied 审计', async () => {
    const token = await mcpToken();
    const { db, calls } = boundDb({
      employee: { provider: 'grok-bot' },
      responses: [
        ['FROM $job', [{ id: 'job-1', actor_kind: 'agent', actor: 'eng-9', command: 'ops_origin_status', state: 'done' }]],
        // 若回落到“任意持租约员工”判定，这一行会放行；现在只认 provider，必须仍拒绝。
        ['current_employee FROM task', [{ current_employee: 'eng-9' }]],
      ],
    });
    const { body } = await callTool(token, db, 'company_job', { jobId: 'job-1' });
    const result = resultOf(body);
    expect(result?.isError).toBe(true);
    expect((result?.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
    expect(DENIED_AUDITS(calls).length).toBeGreaterThan(0);
  });

  test('company_job 查本身份员工的作业 → 只返回投影字段', async () => {
    const token = await mcpToken();
    const { db } = boundDb({
      responses: [['FROM $job', [{
        id: 'job-1', actor_kind: 'agent', actor: EMPLOYEE, command: 'ops_origin_status', state: 'done',
        result: '{"ok":true}', input: '{"secret":1}', runner: 'vps-1',
        task: new RecordId('task', 't1'), created_at: '2030-01-01T00:00:00Z', finished_at: '2030-01-01T00:01:00Z',
      }]]],
    });
    const { body } = await callTool(token, db, 'company_job', { jobId: 'job-1' });
    const value = resultOf(body)?.structuredContent as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(['command', 'created_at', 'finished_at', 'id', 'result', 'state', 'task'].sort());
    expect(value.command).toBe('ops_origin_status');
    expect(value.task).toBe('task:t1');
    expect(value.actor).toBeUndefined();
    expect(value.input).toBeUndefined();
    expect(value.runner).toBeUndefined();
  });

  describe('写工具（task_submit / task_review / task_block）', () => {
    const setClauseOf = (sql: string) => sql.slice(sql.indexOf(' SET ') + 5, sql.indexOf(' WHERE '));

    test('task_submit 写入 mcp_outcome 且只写这一个字段', async () => {
      const token = await mcpToken();
      const { db, calls } = boundDb();
      const { body } = await callTool(token, db, 'task_submit', {
        taskId: 't1', summary: '完成了公司 MCP 第二期写工具与预算的实现', pr: 'https://github.com/o/r/pull/12', sha: 'ABCDEF1234',
      });
      const value = resultOf(body)?.structuredContent as { recorded?: boolean; kind?: string };
      expect(value).toEqual({ recorded: true, kind: 'submit' });
      const update = calls.find((call) => call.sql.includes('SET mcp_outcome'))!;
      // 只写 mcp_outcome（含其 at），不碰 version/fence/state/current_employee/delivery_id。
      const set = setClauseOf(update.sql);
      expect(set).toContain('mcp_outcome');
      for (const field of ['version', 'fence', 'state', 'current_employee', 'delivery_id']) expect(set).not.toContain(field);
      const outcome = update.vars.o as Record<string, unknown>;
      expect(outcome.kind).toBe('submit');
      expect(outcome.employee).toBe(EMPLOYEE);
      expect(outcome.delivery).toBe('del-1');
      expect(outcome.fence).toBe(3);
      expect(outcome.sub).toBe(SUB);
      expect(outcome.pr).toBe('https://github.com/o/r/pull/12');
      expect(outcome.sha).toBe('abcdef1234'); // 小写化
      expect(calls.some((call) => call.sql.includes('CREATE ops_audit') && call.vars.outcome === 'ok' && call.vars.actor === EMPLOYEE)).toBe(true);
    });

    test('task_submit 在复核任务上 → invalid「复核阶段请用 task_review」', async () => {
      const token = await mcpToken();
      const { db } = boundDb({ task: { ...LEASED_TASK, state: 'review' } });
      const { body } = await callTool(token, db, 'task_submit', { taskId: 't1', summary: '完成了公司 MCP 第二期写工具与预算的实现' });
      const result = resultOf(body);
      expect(result?.isError).toBe(true);
      expect((result?.structuredContent as { error: { code: string; message: string } }).error.code).toBe('invalid');
      expect((result?.structuredContent as { error: { code: string; message: string } }).error.message).toContain('task_review');
    });

    test('task_review 在执行任务上 → invalid；复核任务上正例写 verdict', async () => {
      const token = await mcpToken();
      const { db: doingDb } = boundDb();
      const wrongRes = await callTool(token, doingDb, 'task_review', { taskId: 't1', verdict: 'pass', findings: '复核结论与逐条证据都在这里，足够长，足够长' });
      const wrong = resultOf(wrongRes.body);
      expect(wrong?.isError).toBe(true);
      expect((wrong?.structuredContent as { error: { message: string } }).error.message).toContain('task_submit');

      const { db } = boundDb({ task: { ...LEASED_TASK, state: 'review' } });
      const { body } = await callTool(token, db, 'task_review', { taskId: 't1', verdict: 'return', findings: '退回：第三条验收没有给出证据，需要补上再交' });
      const value = resultOf(body)?.structuredContent as { recorded?: boolean; kind?: string };
      expect(value).toEqual({ recorded: true, kind: 'review' });
    });

    test('task_block 写 kind=block 的结论', async () => {
      const token = await mcpToken();
      const { db, calls } = boundDb();
      const { body } = await callTool(token, db, 'task_block', { taskId: 't1', reason: '供应商测试环境不可用，无法验证，需要等恢复' });
      const value = resultOf(body)?.structuredContent as { recorded?: boolean; kind?: string };
      expect(value).toEqual({ recorded: true, kind: 'block' });
      const outcome = calls.find((call) => call.sql.includes('SET mcp_outcome'))!.vars.o as Record<string, unknown>;
      expect(outcome.kind).toBe('block');
      expect(outcome.text).toContain('测试环境不可用');
    });

    test('写工具：租约过期与别 provider → forbidden 且写 denied 审计；读后租约变化 → 任务租约已变化', async () => {
      const token = await mcpToken();
      for (const task of [
        { ...LEASED_TASK, lease_expires_at: 1 },
        { ...LEASED_TASK },
      ]) {
        const other = task.lease_expires_at === 1
          ? boundDb({ task })
          : boundDb({ task, employee: { provider: 'grok-bot' } });
        const { body } = await callTool(token, other.db, 'task_submit', { taskId: 't1', summary: '完成了公司 MCP 第二期写工具与预算的实现' });
        const result = resultOf(body);
        expect(result?.isError).toBe(true);
        expect((result?.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
        expect(DENIED_AUDITS(other.calls).length).toBeGreaterThan(0);
      }
      const { db } = boundDb({ responses: [['SET mcp_outcome', []]] });
      const { body } = await callTool(token, db, 'task_submit', { taskId: 't1', summary: '完成了公司 MCP 第二期写工具与预算的实现' });
      const result = resultOf(body);
      expect(result?.isError).toBe(true);
      expect((result?.structuredContent as { error: { code: string; message: string } }).error.code).toBe('forbidden');
      expect((result?.structuredContent as { error: { code: string; message: string } }).error.message).toContain('任务租约已变化');
    });
  });

  describe('company_ops 次数预算', () => {
    const opsCall = (token: string, db: Surreal) => callTool(token, db, 'company_ops', { taskId: 't1', tool: 'ops_origin_status', args: {} });
    const enqueued = (calls: FakeCall[]) => calls.filter((call) => call.sql.includes('CREATE $job'));

    test('默认预算 3：已用 3 次再调 → forbidden 且不入队', async () => {
      const token = await mcpToken();
      const { db, calls } = boundDb({
        task: { ...LEASED_TASK, mcp_ops_used: { delivery: 'del-1', counts: { ops_origin_status: 3 } } },
      });
      const { body } = await opsCall(token, db);
      const result = resultOf(body);
      expect(result?.isError).toBe(true);
      expect((result?.structuredContent as { error: { code: string; message: string } }).error.code).toBe('forbidden');
      expect((result?.structuredContent as { error: { code: string; message: string } }).error.message).toContain('3/3');
      expect(enqueued(calls)).toHaveLength(0);
      expect(DENIED_AUDITS(calls).length).toBeGreaterThan(0);
    });

    test('覆盖预算 1 与 0：用完即拒；新 delivery 视为 0', async () => {
      const token = await mcpToken();
      const over1 = boundDb({
        task: { ...LEASED_TASK, mcp_budget: { ops_origin_status: 1 }, mcp_ops_used: { delivery: 'del-1', counts: { ops_origin_status: 1 } } },
      });
      const r1 = resultOf((await opsCall(token, over1.db)).body);
      expect((r1?.structuredContent as { error: { code: string; message: string } }).error.code).toBe('forbidden');
      expect((r1?.structuredContent as { error: { code: string; message: string } }).error.message).toContain('1/1');

      const over0 = boundDb({ task: { ...LEASED_TASK, mcp_budget: { ops_origin_status: 0 } } });
      const r0 = resultOf((await opsCall(token, over0.db)).body);
      expect((r0?.structuredContent as { error: { code: string; message: string } }).error.code).toBe('forbidden');
      expect(enqueued(over0.calls)).toHaveLength(0);

      // 旧 delivery 的计数在新租约下重置：正常扣次并入队。
      const fresh = boundDb({
        task: { ...LEASED_TASK, mcp_ops_used: { delivery: 'old-delivery', counts: { ops_origin_status: 3 } } },
      });
      const { body } = await opsCall(token, fresh.db);
      const value = resultOf(body)?.structuredContent as { pending?: boolean };
      expect(value.pending).toBe(true);
      const spend = fresh.calls.find((call) => call.sql.includes('SET mcp_ops_used'))!;
      expect((spend.vars.next as { counts: Record<string, number> }).counts.ops_origin_status).toBe(1);
      expect((spend.vars.next as { delivery: string }).delivery).toBe('del-1');
    });

    test('新白名单工具受预算约束：ops_origin_logs 预算 1，第二次调用 forbidden 且不入队', async () => {
      const token = await mcpToken();
      const { db, calls } = boundDb({
        task: { ...LEASED_TASK, mcp_budget: { ops_origin_logs: 1 } },
      });
      const first = resultOf((await callTool(token, db, 'company_ops', { taskId: 't1', tool: 'ops_origin_logs', args: {} })).body);
      expect((first?.structuredContent as { pending?: boolean }).pending).toBe(true);
      const second = resultOf((await callTool(token, db, 'company_ops', { taskId: 't1', tool: 'ops_origin_logs', args: {} })).body);
      expect(second?.isError).toBe(true);
      expect((second?.structuredContent as { error: { code: string; message: string } }).error.code).toBe('forbidden');
      expect((second?.structuredContent as { error: { code: string; message: string } }).error.message).toContain('1/1');
      // 只有第一次入了队。
      expect(calls.filter((call) => call.sql.includes('CREATE $job'))).toHaveLength(1);
    });

    test('扣次条件 UPDATE 连续未命中 → conflict；命中即计次（含 pending）', async () => {
      const token = await mcpToken();
      const { db } = boundDb({ responses: [['SET mcp_ops_used', []]] });
      const result = resultOf((await opsCall(token, db)).body);
      expect(result?.isError).toBe(true);
      expect((result?.structuredContent as { error: { code: string } }).error.code).toBe('conflict');

      const ok = boundDb();
      const { body } = await opsCall(token, ok.db);
      const value = resultOf(body)?.structuredContent as { pending?: boolean };
      expect(value.pending).toBe(true);
      expect((ok.calls.find((call) => call.sql.includes('SET mcp_ops_used'))!.vars.next as { counts: Record<string, number> }).counts.ops_origin_status).toBe(1);
    });
  });

  describe('老板命令 mcp.budget.set 与 mcp.principal.pending', () => {
    test('mcp.budget.set 非白名单工具拒绝；合法值落库；空对象清除', async () => {
      const { db } = boundDb();
      await expect(runOwnerApi(db, 'mcp.budget.set', { taskId: 't1', budget: { host_exec: 2 } }, 'test'))
        .rejects.toMatchObject({ code: 'invalid' });
      const { db: okDb } = boundDb({ responses: [['UPDATE $task SET mcp_budget', [{ id: 't1' }]]] });
      const set = await runOwnerApi(okDb, 'mcp.budget.set', { taskId: 't1', budget: { ops_origin_status: 5 } }, 'test') as { taskId: string; budget: Record<string, number> };
      expect(set.taskId).toBe('t1');
      expect(set.budget).toEqual({ ops_origin_status: 5 });
      const cleared = await runOwnerApi(okDb, 'mcp.budget.set', { taskId: 't1', budget: {} }, 'test') as { budget: unknown };
      expect(cleared.budget).toBeNull();
    });

    test('mcp.principal.pending 聚合近 7 天未登记尝试，排除已登记主体', async () => {
      const { db } = boundDb({
        responses: [['FROM ops_audit', [
          { actor: 'mcp:new-sub', at: '2030-01-01T00:00:00Z', command: 'task_context' },
          { actor: 'mcp:new-sub', at: '2030-01-01T00:01:00Z', command: 'company_ops' },
          { actor: 'mcp:other-sub', at: '2030-01-01T00:02:00Z', command: 'task_current' },
          { actor: `mcp:${SUB}`, at: '2030-01-01T00:03:00Z', command: 'task_context' },
        ]]],
      });
      const out = await runOwnerApi(db, 'mcp.principal.pending', {}, 'test') as { pending: Array<{ sub: string; attempts: number; lastAt: unknown; lastCommand: string }> };
      expect(out.pending).toEqual([
        { sub: 'new-sub', attempts: 2, lastAt: '2030-01-01T00:00:00Z', lastCommand: 'task_context' },
        { sub: 'other-sub', attempts: 1, lastAt: '2030-01-01T00:02:00Z', lastCommand: 'task_current' },
      ]);
    });

    test('员工/自动化不能调 mcp.*（HARD_OWNER_ONLY 命中 mcp.budget.set 与 mcp.principal.*）', () => {
      for (const command of ['mcp.budget.set', 'mcp.principal.set', 'mcp.principal.pending', 'mcp.principal.list']) {
        expect(HARD_OWNER_ONLY.some((pattern) => matchesCommand(pattern, command))).toBe(true);
      }
      expect(HARD_OWNER_ONLY.some((pattern) => matchesCommand(pattern, 'mcp_tool.task_submit'))).toBe(false);
    });
  });
});
