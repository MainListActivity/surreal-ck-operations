import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { ClaimResult, CompanyCore, Principal, TaskView, WorktreeAssignment } from '../src/contracts';
import { connectCompanyClient } from '../src/mcp/client';
import { createMcpHttpService } from '../src/mcp/server';
import {
  answerBytes, answerResult, jsonBytes, MAX_REQUEST_ID_BYTES, RESPONSE_BUDGET_BYTES, SSE_RPC_FRAME_BYTES,
} from '../src/response-budget.ts';
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
beforeEach(() => { active = true; unavailable = false; });

/** A JSON-RPC message as a client reads it: one JSON document, or the data line of a server-sent event. */
interface RpcMessage {
  id?: unknown;
  result?: { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
  error?: { code: number; message: string };
}
const messageOf = (body: string): RpcMessage => {
  const line = body.split('\n').find(text => text.startsWith('data: '));
  return JSON.parse(line ? line.slice('data: '.length) : body) as RpcMessage;
};
/** The text copy of a result, read the way a client that reads only text reads it. */
const textOf = (result: { content?: unknown }): string => (result.content as Array<{ text?: string }>)[0]!.text!;
/**
 * One tools/call sent as raw JSON-RPC with a chosen id, since the SDK picks its own ids. Returns the status, the whole reply in
 * bytes (what a client receives), and the message in it (SYS01, D2).
 */
async function rawCall(target: URL, id: unknown, name: string, args: Record<string, unknown>, credential = 'sck_valid') {
  const response = await fetch(target, {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(body, 'utf8'), message: messageOf(body) };
}
/** The stub core with one task whose context is `context()` long. The length is read on each call, so one service can be probed. */
const sizedCore = (context: () => string): CompanyCore => ({ ...core, getTask: async () => ({ ...task, context: context() }) }) as unknown as CompanyCore;
/** A claim at every legal maximum at once: long title and context, 200 dependencies, 50 long intent paths, a project, six predecessors and eight full history entries. */
function worstClaim(): ClaimResult {
  const cjkPath = (index: number): string => `${String(index).padStart(3, '0')}-${'甲'.repeat(296)}`;
  const paths = Array.from({ length: 50 }, (_, index) => cjkPath(index));
  const worktree = { id: 'wt-claim', repo: '/repos/proj', worktreePath: '/wt/claim', mode: 'exclusive', discipline: '代码', intent: { kind: 'assets', paths } } as unknown as WorktreeAssignment;
  const evidence = '证'.repeat(680);
  const history = Array.from({ length: 8 }, (_, index) => ({
    auditId: `audit-${index}`, action: 'checkpoint', actor: 'eng-01', version: index, at: '2026-10-19T18:00:00.000Z',
    evidence, evidenceBytes: Buffer.byteLength(evidence, 'utf8'), evidenceSha256: 'f'.repeat(64),
  }));
  return {
    task: {
      ...task, title: '甲'.repeat(200), context: '甲'.repeat(20_000), state: 'doing', currentEmployee: 'eng-01', deliveryId: 'delivery-claim',
      dependencies: Array.from({ length: 200 }, (_, index) => `task-${String(index).padStart(4, '0')}-${'d'.repeat(120)}`),
      workIntent: { kind: 'assets', paths }, leaseExpiresAt: '2026-10-19T19:00:00.000Z', version: 4, fence: 3,
    },
    deliveryId: 'delivery-claim', fence: 3, leaseExpiresAt: '2026-10-19T19:00:00.000Z',
    history, historyCount: history.length, historyComplete: true,
    predecessors: Array.from({ length: 6 }, (_, index) => ({
      employee: `eng-${index}-${'e'.repeat(60)}`, agentId: 'a'.repeat(64), provider: 'claude', role: 'engineering', retired: false,
    })),
    project: {
      id: 'proj', name: '项目', repoPath: '/repos/proj', defaultBranch: 'main', release: '甲'.repeat(2_600),
      redLines: ['no secrets in evidence'], runbooks: Array.from({ length: 20 }, () => '甲'.repeat(60)), envs: [],
    },
    worktree,
  } as unknown as ClaimResult;
}

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
    expect(tools).toContain('task_intent_update');
    // 经理在途任务验收要求追加：与其它 gm 工具同一条 MCP 表面（角色与能力在 core 判定）。
    expect(tools).toContain('task_acceptance_amend');
    expect(tools).toContain('goal_acceptance_preview');
    expect(tools).toContain('goal_acceptance_repair');
    expect(tools).toContain('implementer_takeover');
    // SYS01 R1: the recovery entry for a worktree whose references were cut from a page.
    expect(tools).toContain('read_worktree_refs');
    // SYS-DISP IR01: the read-only candidate preflight (gm/qa) rides the same surface as the write entry.
    expect(tools).toContain('independence_set');
    expect(tools).toContain('identity_principal_set');
    expect(tools).toContain('independence_check');
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

test('a listing call whose reconnect is still pending at its reply ceiling is answered 503 at the ceiling, not after the reconnect (SYS01 M1)', async () => {
  const stalled = createMcpHttpService({ core, port: 0, heal: () => new Promise<void>(() => undefined) });
  try {
    const started = Date.now();
    const response = await fetch(new URL(`http://127.0.0.1:${stalled.port}/mcp`), {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: 'Bearer sck_valid' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_context', arguments: {} } }),
    });
    const elapsed = Date.now() - started;
    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThan(12_000);
    expect(elapsed).toBeLessThan(14_000);
  } finally { await stalled.close(); }
}, 30_000);

test('a listing call whose authentication is still pending at its reply ceiling is answered 503 at the ceiling, not at the 55s budget (SYS01 M1)', async () => {
  const stalledAuth = createMcpHttpService({
    core: { ...core, authenticate: () => new Promise<never>(() => undefined) } as unknown as CompanyCore,
    port: 0,
  });
  try {
    const started = Date.now();
    const response = await fetch(new URL(`http://127.0.0.1:${stalledAuth.port}/mcp`), {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: 'Bearer sck_valid' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {} } }),
    });
    const elapsed = Date.now() - started;
    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThan(12_000);
    expect(elapsed).toBeLessThan(14_000);
  } finally { await stalledAuth.close(); }
}, 30_000);

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

test('the whole MCP result, text copy included, is held to 48 KiB on the wire: a context that fits arrives whole, a larger one is refused (SYS01, F5, D1)', async () => {
  const fits = [8, 12, 16, 20].map(kib => kib * 1024);
  const refused = [24, 25, 40, 50].map(kib => kib * 1024);
  for (const size of [...fits, ...refused]) {
    const context = 'a'.repeat(size);
    const sized = createMcpHttpService({ core: sizedCore(() => context), port: 0 });
    const wire = countingFetch();
    const connection = await connectCompanyClient({
      url: new URL(`http://127.0.0.1:${sized.port}/mcp`), credential: 'sck_valid', clientName: 'f5-wire', fetch: wire.fetch,
    });
    try {
      const answer = await connection.client.callTool({ name: 'get_context', arguments: { taskId: task.id } });
      // The client receives the whole body of the call: frame, text copy and structured copy. The whole body must stay in budget.
      expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      if (fits.includes(size)) {
        expect(answer.structuredContent).toMatchObject({ ok: true, data: { tasks: [{ id: task.id, context }] } });
        expect(textOf(answer)).toBe(JSON.stringify((answer.structuredContent as { data: unknown }).data));
      } else {
        expect(answer.structuredContent).toMatchObject({ ok: false, code: 'response_too_large', retryable: false });
        expect(JSON.parse(textOf(answer))).toEqual(answer.structuredContent);
      }
    } finally {
      await connection.close();
      await sized.close();
    }
  }
});

test('the largest answer within the budget is sent at its measured size plus the frame, the widest id leaves 72 bytes, and one character more is refused (SYS01, D2, F5)', async () => {
  let length = 0;
  const sized = createMcpHttpService({ core: sizedCore(() => 'a'.repeat(length)), port: 0 });
  const target = new URL(`http://127.0.0.1:${sized.port}/mcp`);
  const probe = (chars: number, id: unknown = 1) => {
    length = chars;
    return rawCall(target, id, 'get_context', { taskId: task.id });
  };
  try {
    // Bisection on the context length: every length up to the largest one that fits gets the answer.
    let lo = 0;
    let hi = RESPONSE_BUDGET_BYTES;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((await probe(mid)).message.result?.structuredContent.ok === true) lo = mid;
      else hi = mid - 1;
    }
    const fitting = await probe(lo);
    const data = fitting.message.result!.structuredContent.data;
    expect(answerBytes(data)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(answerBytes(data)).toBeGreaterThanOrEqual(RESPONSE_BUDGET_BYTES - 1);
    // The reply is the answer, the SSE lines, the JSON-RPC envelope and the id, and nothing else.
    expect(fitting.bytes).toBe(SSE_RPC_FRAME_BYTES + jsonBytes(1) + jsonBytes(answerResult(data)));
    const widest = await probe(lo, 'x'.repeat(MAX_REQUEST_ID_BYTES - 2));
    expect(widest.status).toBe(200);
    expect(widest.bytes).toBe(SSE_RPC_FRAME_BYTES + MAX_REQUEST_ID_BYTES + jsonBytes(answerResult(data)));
    expect(widest.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES - 72);
    // One character more is refused as response_too_large, and the refusal is a small, legal JSON result.
    const over = await probe(lo + 1);
    expect(over.message.result?.structuredContent).toMatchObject({ ok: false, code: 'response_too_large' });
    expect(over.bytes).toBeLessThan(RESPONSE_BUDGET_BYTES);
  } finally {
    await sized.close();
  }
});

test('the text copy of every result is the JSON of its data, and a refusal is JSON too, so a client that reads text and one that reads structure agree (SYS01, D1)', async () => {
  const connection = await connectCompanyClient({ url, credential: 'sck_valid', clientName: 'text-copy-test' });
  try {
    const answer = await connection.client.callTool({ name: 'get_context', arguments: { taskId: task.id } });
    expect(textOf(answer)).toBe(JSON.stringify((answer.structuredContent as { data: unknown }).data));
    const claim = await connection.client.callTool({ name: 'claim_next', arguments: { taskId: task.id } });
    expect(textOf(claim)).toBe(JSON.stringify((claim.structuredContent as { data: unknown }).data));
    const refused = await connection.client.callTool({ name: 'create_task', arguments: {
      title: 'denied', context: 'synthetic', executorRole: 'qa', reviewerRole: 'gm', idempotencyKey: 'text-copy',
    } });
    expect(refused.structuredContent).toMatchObject({ ok: false, code: 'forbidden' });
    expect(JSON.parse(textOf(refused))).toEqual(refused.structuredContent);
  } finally { await connection.close(); }
});

test('request ids: up to 128 serialized bytes are accepted and echoed; a larger id is refused before any tool runs, with a null id (SYS01, D2)', async () => {
  let reads = 0;
  let claims = 0;
  const counted = createMcpHttpService({
    core: {
      ...core,
      getTask: async () => { reads += 1; return task; },
      claim: async () => {
        claims += 1;
        return { task: { ...task, state: 'doing' as const, version: 2 }, deliveryId: 'delivery-1', fence: 1, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(), history: [] };
      },
    } as unknown as CompanyCore,
    port: 0,
  });
  const target = new URL(`http://127.0.0.1:${counted.port}/mcp`);
  try {
    // Each id serializes to at most 128 bytes: a number, a UUID, 126 ASCII characters (128 with quotes), 42 CJK characters
    // (126 bytes, 128 with quotes) and 63 quotes (each escaped to two bytes, 128 with the quotes).
    const accepted: unknown[] = [1, Number.MAX_SAFE_INTEGER, '6f1c2a9e-5b7d-4c3a-9e8f-1a2b3c4d5e6f', 'x'.repeat(126), '中'.repeat(42), '"'.repeat(63)];
    for (const id of accepted) {
      const reply = await rawCall(target, id, 'get_context', { taskId: task.id });
      expect(reply.status).toBe(200);
      expect(reply.message).toMatchObject({ id, result: { structuredContent: { ok: true } } });
    }
    expect(reads).toBe(accepted.length);
    // One byte more is refused before any tool runs: 127 ASCII characters, 43 CJK characters and 64 quotes all pass 128 bytes.
    for (const id of ['x'.repeat(127), '中'.repeat(43), '"'.repeat(64)]) {
      const reply = await rawCall(target, id, 'get_context', { taskId: task.id });
      expect(reply.status).toBe(400);
      expect(reply.message).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    }
    expect(reads).toBe(accepted.length);
    // A refused claim is never made, and an accepted id on claim_next gets its confirmation.
    expect((await rawCall(target, 'x'.repeat(128), 'claim_next', { taskId: task.id })).status).toBe(400);
    expect(claims).toBe(0);
    const claimed = await rawCall(target, 'x'.repeat(126), 'claim_next', { taskId: task.id });
    expect(claimed.message.result?.structuredContent).toMatchObject({ ok: true, data: { deliveryId: 'delivery-1', fence: 1 } });
    expect(claims).toBe(1);
  } finally {
    await counted.close();
  }
});

test('a committed claim is confirmed at every legal maximum with the widest accepted id, and its text parses (SYS01, D2, R3)', async () => {
  const claim = worstClaim();
  const claiming = createMcpHttpService({ core: { ...core, claim: async () => claim } as unknown as CompanyCore, port: 0 });
  const target = new URL(`http://127.0.0.1:${claiming.port}/mcp`);
  try {
    for (const id of [1, 'x'.repeat(MAX_REQUEST_ID_BYTES - 2)]) {
      const reply = await rawCall(target, id, 'claim_next', { taskId: task.id });
      expect(reply.status).toBe(200);
      expect(reply.message.result?.structuredContent).toMatchObject({
        ok: true, data: { deliveryId: 'delivery-claim', fence: 3, leaseExpiresAt: claim.leaseExpiresAt },
      });
      const data = reply.message.result!.structuredContent.data;
      expect(answerBytes(data)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      expect(reply.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES - 72);
      expect(JSON.parse(reply.message.result!.content[0]!.text)).toEqual(data);
    }
  } finally {
    await claiming.close();
  }
});

test('reclaim_worktrees over MCP refuses null, every non-boolean dryRun and a bad path list as a structured invalid result, before the registry runs (SYS01, D3)', async () => {
  const reclaims: unknown[] = [];
  const gm = createMcpHttpService({
    core: {
      ...core,
      authenticate: async () => ({ ...principal, role: 'gm' as const }),
      reclaimWorktrees: async (_credential: string, input: unknown) => {
        reclaims.push(input);
        return { scanId: 's', removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 };
      },
    } as unknown as CompanyCore,
    port: 0,
  });
  const connection = await connectCompanyClient({ url: new URL(`http://127.0.0.1:${gm.port}/mcp`), credential: 'sck_valid', clientName: 'reclaim-mcp-test' });
  try {
    // The same rule as core and the sidecar refuses each of these: a structured invalid result, JSON in both copies, and no reclaim.
    for (const args of [{ dryRun: null }, { dryRun: 'true' }, { dryRun: 1 }, { dryRun: 0 }, { dryRun: '' }, { repos: '/repo/a' }, { repos: [null] }, { repos: [' '] }]) {
      const refused = await connection.client.callTool({ name: 'reclaim_worktrees', arguments: args });
      expect(refused.structuredContent).toMatchObject({ ok: false, code: 'invalid', retryable: false });
      expect(JSON.parse(textOf(refused))).toEqual(refused.structuredContent);
    }
    expect(reclaims).toEqual([]);
    await connection.client.callTool({ name: 'reclaim_worktrees', arguments: { dryRun: true } });
    await connection.client.callTool({ name: 'reclaim_worktrees', arguments: {} });
    expect(reclaims).toEqual([{ dryRun: true }, { dryRun: false }]);
  } finally {
    await connection.close();
    await gm.close();
  }
});

test('health and readiness remain separate from MCP authentication', async () => {
  expect((await fetch(new URL('/health', url))).status).toBe(200);
  expect((await fetch(new URL('/ready', url))).status).toBe(503);
});
