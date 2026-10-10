import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { CompanyCore, Principal, TaskView } from '../src/contracts';
import { connectCompanyClient } from '../src/mcp/client';
import { createMcpHttpService } from '../src/mcp/server';

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
  async claim() { return { task: { ...task, state: 'doing' as const, version: 2 }, deliveryId: 'delivery-1', fence: 1, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() }; },
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

test('health and readiness remain separate from MCP authentication', async () => {
  expect((await fetch(new URL('/health', url))).status).toBe(200);
  expect((await fetch(new URL('/ready', url))).status).toBe(503);
});
