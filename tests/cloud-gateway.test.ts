import { describe, expect, test } from 'bun:test';
import { GatewayClient, GatewayError } from '../src/cloud/gateway.ts';

const URL_BASE = 'https://gw.example.test';
const TOKEN = 'tok-gateway-1';

type Call = { url: string; init: RequestInit; body: { command: string; input: unknown } };

function fakeFetch(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? 'null')),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ok = (result: unknown) => json({ ok: true, result });
const fail = (code: string, message: string, status = 400) => json({ ok: false, error: { code, message } }, status);

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

const noSleep = async () => {};

describe('GatewayClient.call', () => {
  test('ok 直接返回 result，并带正确的 Bearer 头与 body', async () => {
    const { fn, calls } = fakeFetch(() => ok({ value: 42 }));
    const client = new GatewayClient({ url: `${URL_BASE}/`, fetch: fn });
    expect(await client.call(TOKEN, 'board.read', { a: 1 })).toEqual({ value: 42 });
    expect(calls[0]?.url).toBe(`${URL_BASE}/api/cmd`);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ command: 'board.read', input: { a: 1 } });
  });

  test('error 响应抛 GatewayError 并带 code', async () => {
    const { fn } = fakeFetch(() => fail('forbidden', '没有权限', 403));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y'));
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('forbidden');
  });

  test('未知 code 归一为 upstream_error', async () => {
    const { fn } = fakeFetch(() => fail('weird_code', 'x', 500));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    expect(((await catchError(client.call(TOKEN, 'x.y'))) as GatewayError).code).toBe('upstream_error');
  });

  test('pending 后轮询 ops.job.get 直到 done 返回 result', async () => {
    const states = [
      () => json({ ok: false, error: { code: 'pending', message: 'job-1' } }, 202),
      () => ok({ id: 'job-1', state: 'queued' }),
      () => ok({ id: 'job-1', state: 'running' }),
      () => ok({ id: 'job-1', state: 'done', result: { answer: 'yes' } }),
    ];
    const sleeps: number[] = [];
    const { fn, calls } = fakeFetch((_call, index) => (states[index] as () => Response)());
    const client = new GatewayClient({
      url: URL_BASE,
      fetch: fn,
      pollMs: 0,
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    expect(await client.call(TOKEN, 'ops.run', { q: 1 })).toEqual({ answer: 'yes' });
    expect(calls).toHaveLength(4);
    for (const call of calls.slice(1)) {
      expect(call.body).toEqual({ command: 'ops.job.get', input: { id: 'job-1' } });
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(sleeps).toEqual([0, 0]);
  });

  test('作业 state 为 error 时抛 GatewayError，code 取 error.code', async () => {
    const { fn } = fakeFetch((_call, index) =>
      index === 0
        ? json({ ok: false, error: { code: 'pending', message: 'job-2' } }, 202)
        : ok({ id: 'job-2', state: 'error', error: { code: 'conflict', message: '冲突' } }),
    );
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });
    const error = await catchError(client.call(TOKEN, 'ops.run'));
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('conflict');
  });

  test('作业 error 且无 error.code 时 code 为 upstream_error', async () => {
    const { fn } = fakeFetch((_call, index) =>
      index === 0
        ? json({ ok: false, error: { code: 'pending', message: 'job-3' } }, 202)
        : ok({ id: 'job-3', state: 'error' }),
    );
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });
    expect(((await catchError(client.call(TOKEN, 'ops.run'))) as GatewayError).code).toBe('upstream_error');
  });

  test('轮询超时抛 pending', async () => {
    const { fn } = fakeFetch((_call, index) =>
      index === 0
        ? json({ ok: false, error: { code: 'pending', message: 'job-4' } }, 202)
        : ok({ id: 'job-4', state: 'running' }),
    );
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, pollTimeoutMs: 0, sleep: noSleep });
    const error = await catchError(client.call(TOKEN, 'ops.run'));
    expect((error as GatewayError).code).toBe('pending');
    expect((error as GatewayError).message).toBe('作业仍在执行，稍后再取');
  });

  test('非 JSON 响应抛 upstream_error', async () => {
    const { fn } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y'));
    expect((error as GatewayError).code).toBe('upstream_error');
    expect((error as GatewayError).message).toBe('HTTP 502');
  });

  test('错误信息中的令牌被脱敏', async () => {
    const leaked = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    const { fn } = fakeFetch(() => fail('unauthorized', `bad token ${leaked}`, 401));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y'));
    expect((error as GatewayError).message).not.toContain(leaked);
  });

  test('命令名为空或超过 128 字符时不发请求', async () => {
    const { fn, calls } = fakeFetch(() => ok(null));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    expect(await catchError(client.call(TOKEN, ''))).toBeInstanceOf(GatewayError);
    expect(await catchError(client.call(TOKEN, 'c'.repeat(129)))).toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(0);
  });

  test('非 https 的网关地址在构造时拒绝', () => {
    expect(() => new GatewayClient({ url: 'http://evil.example' })).toThrow();
    expect(() => new GatewayClient({ url: 'http://localhost:8080' })).not.toThrow();
  });
});
