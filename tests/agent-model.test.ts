import { describe, expect, test } from 'bun:test';
import { daemonBase, parseMcpReply, setAgentModel } from '../src/dispatcher/agent-model.ts';

describe('daemon address', () => {
  const never = () => { throw new Error('unreadable'); };
  test('an explicit URL wins and a ws:// one is turned into http://', () => {
    expect(daemonBase({ PASEO_DAEMON_URL: 'ws://127.0.0.1:7000/ws' }, never)).toBe('http://127.0.0.1:7000/ws');
    expect(daemonBase({ SCK_PASEO_DAEMON_URL: 'http://10.0.0.2:6767' }, never)).toBe('http://10.0.0.2:6767');
  });
  test('the address Paseo publishes for itself is used when no override is set', () => {
    const read = () => JSON.stringify({ daemon: { listen: '127.0.0.1:6799' } });
    expect(daemonBase({}, read)).toBe('http://127.0.0.1:6799');
  });
  test('a missing or malformed config falls back to the default port', () => {
    expect(daemonBase({}, never)).toBe('http://127.0.0.1:6767');
    expect(daemonBase({}, () => 'not json')).toBe('http://127.0.0.1:6767');
    expect(daemonBase({}, () => JSON.stringify({ daemon: {} }))).toBe('http://127.0.0.1:6767');
  });
});

describe('MCP reply parsing', () => {
  test('the SSE frame the endpoint really returns reads as success', () => {
    const raw = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"{\\n  \\"success\\": true\\n}"}],"structuredContent":{"success":true}},"jsonrpc":"2.0","id":1}';
    expect(parseMcpReply(raw)).toMatchObject({ ok: true });
  });
  test('a plain JSON body is accepted too', () => {
    expect(parseMcpReply('{"result":{"structuredContent":{"success":true}}}').ok).toBe(true);
  });
  test('a tool-level error is a failure, not a success with text', () => {
    const raw = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Unknown agent \'abc\'"}],"isError":true},"jsonrpc":"2.0","id":9}';
    const parsed = parseMcpReply(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toContain('Unknown agent');
  });
  test('rpc errors, empty bodies and garbage all read as failure', () => {
    expect(parseMcpReply('{"error":{"message":"bad request"}}').ok).toBe(false);
    expect(parseMcpReply('').ok).toBe(false);
    expect(parseMcpReply('not json').ok).toBe(false);
    expect(parseMcpReply('{"jsonrpc":"2.0","id":1}').ok).toBe(false);
  });
});

describe('setting a live agent model', () => {
  const capture = (body: unknown, status = 200) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };
  const okBody = { result: { content: [{ type: 'text', text: '{"success": true}' }], structuredContent: { success: true } } };

  test('it posts update_agent with the model and reports success', async () => {
    const { calls, impl } = capture(okBody);
    expect(await setAgentModel('agent-1', 'claude-haiku-5-5', { base: 'http://x', fetchImpl: impl })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://x/mcp/agents');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.method).toBe('tools/call');
    expect(sent.params).toMatchObject({ name: 'update_agent', arguments: { agentId: 'agent-1', settings: { model: 'claude-haiku-5-5' } } });
  });
  test('every failure resolves false instead of throwing, so the caller keeps the session', async () => {
    const throwing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await setAgentModel('agent-1', 'm', { base: 'http://x', fetchImpl: throwing })).toBe(false);
    expect(await setAgentModel('agent-1', 'm', { base: 'http://x', fetchImpl: capture({}, 500).impl })).toBe(false);
    expect(await setAgentModel('agent-1', 'm', { base: 'http://x', fetchImpl: capture({ error: { message: 'no' } }).impl })).toBe(false);
    expect(await setAgentModel('agent-1', 'm', { base: 'http://x', fetchImpl: capture({ result: { isError: true, content: [] } }).impl })).toBe(false);
  });
  test('an empty agent id or model never reaches the daemon', async () => {
    const { calls, impl } = capture(okBody);
    expect(await setAgentModel('', 'm', { base: 'http://x', fetchImpl: impl })).toBe(false);
    expect(await setAgentModel('agent-1', '', { base: 'http://x', fetchImpl: impl })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
