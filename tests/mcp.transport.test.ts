import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { CompanyCore, Principal, TaskView } from '../src/contracts';
import { connectCompanyClient } from '../src/mcp/client';
import { createMcpHttpService } from '../src/mcp/server';
import { RESPONSE_BUDGET_BYTES } from '../src/response-budget.ts';
import { countingFetch, lastBody } from './support/mcp-wire.ts';

const principal: Principal = { employeeId: 'ai-01', role: 'ai-content', capabilities: ['execute', 'review'] };
const task: TaskView = {
  id: 'task-test', title: 'Adapter smoke', context: 'Synthetic task', state: 'ready',
  executorRole: 'ai-content', reviewerRole: 'engineering', kind: 'task', dependencies: [], version: 1, fence: 0,
};
let active = true;
let unavailable = false;
const core = {
  async authenticate(credential: string) {
    if (unavailable) throw new Error('synthetic storage failure');
    if (credential !== 'sck_valid' || !active) throw { code: 'unauthorized' };
    return principal;
  },
  async companyBrief() { return { directions: [], goals: [], paused: false }; },
  async listTasks() { return [task]; },
  async getTask() { return task; },
  async claim() { return { task: { ...task, state: 'doing' as const, version: 2 }, deliveryId: 'delivery-1', fence: 1, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(), history: [] }; },
  async history() { return []; },
  async createTask() { throw { code: 'forbidden' }; },
} as unknown as CompanyCore;

let service: ReturnType<typeof createMcpHttpService>;
let url: URL;
beforeAll(() => {
  service = createMcpHttpService({ core, port: 0 });
  url = new URL(`http://127.0.0.1:${service.port}/mcp`);
});
afterAll(async () => { await service.close(); });

test('real SDK initialize/list/call and authenticated core identity', async () => {
  const connection = await connectCompanyClient({ url, credential: 'sck_valid', clientName: 'adapter-test' });
  try {
    expect(connection.client.getServerVersion()?.name).toBe('surreal-ck-company');
    const tools = (await connection.client.listTools()).tools.map(tool => tool.name);
    expect(tools).toContain('get_context');
    expect(tools).toContain('claim_next');
    expect(tools).toContain('review');
    // Manage-only workforce tools ride the same surface; capability checks live in core.
    expect(tools).toContain('def_list');
    expect(tools).toContain('def_ensure');
    expect(tools).toContain('project_disciplines_update');
    expect(tools).toContain('defer_task_until');
    expect(tools).toContain('bind_task_code_repo');
    expect(tools).toContain('goal_acceptance_preview');
    expect(tools).toContain('goal_acceptance_repair');
    const result = await connection.client.callTool({ name: 'get_context', arguments: { employeeId: 'gm-01', role: 'gm' } });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { principal: { employeeId: 'ai-01' } } });
    const claim = await connection.client.callTool({ name: 'claim_next', arguments: {} });
    expect(claim.structuredContent).toMatchObject({ ok: true, data: { deliveryId: 'delivery-1', fence: 1 } });
    const denied = await connection.client.callTool({ name: 'create_task', arguments: {
      title: 'denied', context: 'synthetic', executorRole: 'qa', reviewerRole: 'gm', idempotencyKey: 'one',
    } });
    expect(denied.structuredContent).toMatchObject({ ok: false, code: 'forbidden' });
    active = false;
    await expect(connection.client.callTool({ name: 'get_context', arguments: {} })).rejects.toThrow();
    active = true;
  } finally { await connection.close(); }
});

test('null is absent on every MCP read argument, as in core and the sidecar (SYS01, defect 2)', async () => {
  const connection = await connectCompanyClient({ url, credential: 'sck_valid', clientName: 'null-args-test' });
  try {
    const context = await connection.client.callTool({ name: 'get_context', arguments: {
      taskId: null, state: null, goalId: null, role: null, since: null, includeCompany: null, fields: null, pageSize: null, cursor: null,
    } });
    expect(context.structuredContent).toMatchObject({ ok: true, data: { principal: { employeeId: 'ai-01' }, tasks: [task] } });
    const worktrees = await connection.client.callTool({ name: 'list_worktrees', arguments: { taskId: null, includeReleased: null, pageSize: null, cursor: null } });
    expect(worktrees.structuredContent).toEqual({ ok: true, data: [] });
    const history = await connection.client.callTool({ name: 'get_task_history', arguments: { taskId: 'task-test', pageSize: null, cursor: null } });
    expect(history.structuredContent).toEqual({ ok: true, data: [] });
  } finally { await connection.close(); }
});

test('null never enters the paged branch on MCP: null paging routes to the unpaged core call, a real pageSize to the paged one (SYS01, R8)', async () => {
  // A recording stub: the MCP layer must choose the branch from isPaged, so a null pageSize or cursor never reaches worktreePage/historyView.
  const routed: string[] = [];
  const recording = {
    ...core,
    worktreeList: async () => { routed.push('worktreeList'); return [] as never; },
    worktreePage: async () => { routed.push('worktreePage'); return { worktrees: [], page: { returned: 0, hasMore: false } } as never; },
    history: async () => { routed.push('history'); return []; },
    historyView: async () => { routed.push('historyView'); return { history: [], page: { returned: 0, hasMore: false } } as never; },
  } as unknown as CompanyCore;
  const recorded = createMcpHttpService({ core: recording, port: 0 });
  const connection = await connectCompanyClient({
    url: new URL(`http://127.0.0.1:${recorded.port}/mcp`), credential: 'sck_valid', clientName: 'null-route-test',
  });
  try {
    await connection.client.callTool({ name: 'list_worktrees', arguments: { taskId: null, includeReleased: null, pageSize: null, cursor: null } });
    await connection.client.callTool({ name: 'get_task_history', arguments: { taskId: 'task-test', pageSize: null, cursor: null } });
    expect(routed).toEqual(['worktreeList', 'history']);
    await connection.client.callTool({ name: 'list_worktrees', arguments: { pageSize: 5 } });
    expect(routed.at(-1)).toBe('worktreePage');
    await connection.client.callTool({ name: 'get_task_history', arguments: { taskId: 'task-test', cursor: null, pageSize: 3 } });
    expect(routed.at(-1)).toBe('historyView');
  } finally { await connection.close(); await recorded.close(); }
});

test('every request rejects missing, wrong, revoked credential and foreign Host/Origin', async () => {
  const request = { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  }) };
  expect((await fetch(url, request)).status).toBe(401);
  expect((await fetch(url, { ...request, headers: { ...request.headers, Authorization: 'Bearer wrong' } })).status).toBe(401);
  expect((await fetch(url, { ...request, headers: { ...request.headers, Authorization: 'Bearer sck_valid', Host: 'evil.example' } })).status).toBe(403);
  expect((await fetch(url, { ...request, headers: { ...request.headers, Authorization: 'Bearer sck_valid', Origin: 'http://evil.example' } })).status).toBe(403);
  active = false;
  expect((await fetch(url, { ...request, headers: { ...request.headers, Authorization: 'Bearer sck_valid' } })).status).toBe(401);
  unavailable = true;
  expect((await fetch(url, { ...request, headers: { ...request.headers, Authorization: 'Bearer sck_valid' } })).status).toBe(503);
});

test('failed connection heal answers 503 instead of authenticating on a broken socket', async () => {
  const broken = createMcpHttpService({ core, port: 0, heal: () => Promise.reject(new Error('db dead')) });
  try {
    const response = await fetch(new URL(`http://127.0.0.1:${broken.port}/mcp`), {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        Authorization: 'Bearer sck_valid',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    expect(response.status).toBe(503);
  } finally { await broken.close(); }
});

test('gate token guards the public endpoint before bearer auth', async () => {
  active = true;
  unavailable = false;
  const gated = createMcpHttpService({
    core, port: 0, publicHost: 'mcp.example',
    gateToken: async () => 'gate-secret',
  });
  try {
    const u = new URL(`http://127.0.0.1:${gated.port}/mcp`);
    const init = {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        Authorization: 'Bearer sck_valid',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    };
    expect((await fetch(u, init)).status).toBe(401);
    const gatedHeaders = { ...init.headers, 'X-SCK-Token': 'wrong' };
    expect((await fetch(u, { ...init, headers: gatedHeaders })).status).toBe(401);
    const okHeaders = { ...init.headers, 'X-SCK-Token': 'gate-secret' };
    expect((await fetch(u, { ...init, headers: okHeaders })).status).toBe(200);
    expect((await fetch(`${u}?token=gate-secret`, init)).status).toBe(200);
    const publicHostHeaders = { ...okHeaders, Host: 'mcp.example' };
    expect((await fetch(u, { ...init, headers: publicHostHeaders })).status).toBe(200);
    const foreignHostHeaders = { ...okHeaders, Host: 'evil.example' };
    expect((await fetch(u, { ...init, headers: foreignHostHeaders })).status).toBe(403);
  } finally { await gated.close(); }
});

test('the whole MCP response, not only its answer, is held to 48 KiB: 24, 25 and 40 KiB answers arrive whole, a 50 KiB one is refused (SYS01, F5)', async () => {
  for (const size of [24 * 1024, 25 * 1024, 40 * 1024, 50 * 1024]) {
    const context = 'a'.repeat(size);
    const sized = createMcpHttpService({ core: { ...core, getTask: async () => ({ ...task, context }) } as unknown as CompanyCore, port: 0 });
    const wire = countingFetch();
    const connection = await connectCompanyClient({
      url: new URL(`http://127.0.0.1:${sized.port}/mcp`), credential: 'sck_valid', clientName: 'f5-wire', fetch: wire.fetch,
    });
    try {
      const answer = await connection.client.callTool({ name: 'get_context', arguments: { taskId: task.id } });
      // The client receives the whole body of the call: frame, text note and answer. It must stay within the budget.
      expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      if (size < 50 * 1024) expect(answer.structuredContent).toMatchObject({ ok: true, data: { tasks: [{ id: task.id, context }] } });
      else expect(answer.structuredContent).toMatchObject({ ok: false, code: 'response_too_large' });
    } finally {
      await connection.close();
      await sized.close();
    }
  }
});

test('health and readiness remain separate from MCP authentication', async () => {
  expect((await fetch(new URL('/health', url))).status).toBe(200);
  expect((await fetch(new URL('/ready', url))).status).toBe(503);
});
