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

test('health and readiness remain separate from MCP authentication', async () => {
  expect((await fetch(new URL('/health', url))).status).toBe(200);
  expect((await fetch(new URL('/ready', url))).status).toBe(503);
});
