import { expect, test } from 'bun:test';
import edge, { createEdgeHandler, type EdgeEnv, type EdgeFetch } from '../src/edge.ts';

const PUBLIC = 'https://company.maplayer.top';
const BACKEND = 'https://backend.example.test/__company_owner';
const KEY = 'fixture-only-proxy-key-0123456789abcdef';
function env(overrides: Partial<EdgeEnv> = {}): EdgeEnv {
  return {
    ASSETS: { fetch: async () => new Response('static fixture') },
    OWNER_BACKEND_ORIGIN: BACKEND,
    OWNER_PROXY_KEY: KEY,
    ...overrides,
  };
}
const request = (path: string, init?: RequestInit) => new Request(PUBLIC + path, init);

test('只有 /api 和 /api/* 转发，静态资源不依赖后端配置且保留原请求/响应', async () => {
  const original = new Response('asset');
  const seen: Request[] = [];
  let backendCalls = 0;
  const handle = createEdgeHandler(async () => { backendCalls++; return new Response(); });
  const config = env({ OWNER_BACKEND_ORIGIN: '', OWNER_PROXY_KEY: '', ASSETS: {
    fetch: async req => { seen.push(req); return original; },
  } });
  for (const path of ['/', '/app.js', '/auth/callback?code=fixture', '/apiary', '/people/team.webp']) {
    const req = request(path);
    expect(await handle(req, config)).toBe(original);
    expect(seen.at(-1)).toBe(req);
  }
  expect(backendCalls).toBe(0);
  expect(await edge.fetch(request('/'), config)).toBe(original);
});

test('固定前缀保留 API 路径及编码查询，保留方法并禁用自动重定向', async () => {
  const seen: Request[] = [];
  const handle = createEdgeHandler(async req => { seen.push(req); return new Response(null, { status: 204 }); });
  for (const path of ['/api', '/api/events?project=a%2Fb&cursor=1+2', '/api/config']) {
    expect((await handle(request(path, { method: 'HEAD' }), env())).status).toBe(204);
    expect(seen.at(-1)!.url).toBe(BACKEND + path);
    expect(seen.at(-1)!.method).toBe('HEAD');
    expect(seen.at(-1)!.redirect).toBe('manual');
    expect(seen.at(-1)!.cache).toBe('no-store');
    expect(seen.at(-1)!.body).toBeNull();
  }
});

test('覆盖代理密钥和可信 IP，移除转发旁路头，保留业务 Bearer 与真实 Origin', async () => {
  let received: Request | undefined;
  const handle = createEdgeHandler(async req => { received = req; return new Response(); });
  await handle(request('/api/cmd', { method: 'POST', headers: {
    authorization: 'Bearer fixture-owner', origin: PUBLIC, 'content-type': 'application/json', accept: 'application/json',
    'x-company-proxy-key': 'forged', 'x-company-client-ip': '203.0.113.99', 'cf-connecting-ip': '2001:db8::42',
    forwarded: 'host=evil.test;proto=http', 'x-forwarded-for': '203.0.113.99', 'x-forwarded-host': 'evil.test',
    'x-forwarded-proto': 'http', 'x-real-ip': '203.0.113.99', host: 'evil.test',
    connection: 'keep-alive, x-private-hop, invalid name', 'x-private-hop': 'discard', 'proxy-authorization': 'private fixture',
  }, body: '{"command":"fixture"}' }), env());
  const headers = received!.headers;
  expect(headers.get('authorization')).toBe('Bearer fixture-owner');
  expect(headers.get('origin')).toBe(PUBLIC);
  expect(headers.get('content-type')).toBe('application/json');
  expect(headers.get('x-company-proxy-key')).toBe(KEY);
  expect(headers.get('x-company-client-ip')).toBe('2001:db8::42');
  for (const name of ['host', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
    'cf-connecting-ip', 'connection', 'x-private-hop', 'proxy-authorization']) expect(headers.has(name)).toBe(false);
  expect(await received!.text()).toBe('{"command":"fixture"}');
});

test('缺少 Cloudflare 来源 IP 时不采信客户端提供的来源头', async () => {
  const handle = createEdgeHandler(async req => {
    expect(req.headers.get('x-company-client-ip')).toBe('unknown');
    return new Response();
  });
  await handle(request('/api/feedback/product', { headers: {
    'x-company-client-ip': '203.0.113.99', 'x-forwarded-for': '203.0.113.99', origin: 'https://product.example.test',
  } }), env());
});

test('开放请求体流在未结束时即交给后端，代理不预读或复制正文', async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } }, { highWaterMark: 0 });
  let forwarded: Request | undefined;
  const handle = createEdgeHandler(async req => { forwarded = req; return new Response('accepted'); });
  const req = request('/api/cmd', { method: 'POST', body });
  expect((await handle(req, env())).status).toBe(200);
  expect(forwarded!.bodyUsed).toBe(false);
  const reader = forwarded!.body!.getReader();
  writer.enqueue(new TextEncoder().encode('first'));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  writer.enqueue(new TextEncoder().encode('second'));
  writer.close();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('second');
  expect((await reader.read()).done).toBe(true);
});

test('SSE 原响应立即返回且逐块可读，取消下游会取消同一上游流', async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { writer = controller; },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  const upstream = new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  const handle = createEdgeHandler(async () => upstream);
  const result = await handle(request('/api/events'), env());
  expect(result).toBe(upstream);
  expect(result.bodyUsed).toBe(false);
  const reader = result.body!.getReader();
  writer.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
  writer.enqueue(new TextEncoder().encode('event: change\ndata: {"tables":["task"]}\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: change');
  await reader.cancel();
  expect(canceled).toBe(true);
});

test('客户端取消信号传至后端，失败不会重试写请求或回显异常内容', async () => {
  const abort = new AbortController();
  let upstreamSignal: AbortSignal | undefined;
  let calls = 0;
  const handle = createEdgeHandler(req => {
    calls++;
    upstreamSignal = req.signal;
    return new Promise<Response>((_, reject) => req.signal.addEventListener('abort', () => reject(Error(KEY)), { once: true }));
  });
  const result = handle(request('/api/cmd', { method: 'POST', body: '{}', signal: abort.signal }), env());
  abort.abort();
  const response = await result;
  expect(upstreamSignal!.aborted).toBe(true);
  expect(calls).toBe(1);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain(KEY);
});

test('上游所有 3xx 转为安全 502，释放响应体且不转发 Location 或内部头', async () => {
  for (const status of [301, 302, 303, 304, 307, 308]) {
    let canceled = false;
    let calls = 0;
    const body = status === 304 ? null : new ReadableStream({ cancel() { canceled = true; } });
    const handle = createEdgeHandler(async () => {
      calls++;
      return new Response(body, { status, headers: { location: `https://other.example.test/${KEY}`, 'x-company-proxy-key': KEY } });
    });
    const response = await handle(request('/api/cmd', { method: 'POST', body: '{}' }), env());
    expect(response.status).toBe(502);
    expect(response.headers.has('location')).toBe(false);
    expect(response.headers.has('x-company-proxy-key')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain(KEY);
    expect(calls).toBe(1);
    if (body) expect(canceled).toBe(true);
  }
});

test('正常业务错误响应保持原状，网络异常仅返回通用 502', async () => {
  for (const status of [401, 403, 409, 429, 500, 503]) {
    const upstream = Response.json({ ok: false, error: { code: 'fixture' } }, { status });
    expect(await createEdgeHandler(async () => upstream)(request('/api/me'), env())).toBe(upstream);
  }
  let calls = 0;
  const failed = await createEdgeHandler(async () => { calls++; throw Error(`private: ${KEY}`); })(request('/api/cmd', { method: 'POST', body: '{}' }), env());
  expect(calls).toBe(1);
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain(KEY);
});

test('后端配置无效或指回公开入口时关闭代理，不发网络请求且不回显配置', async () => {
  const invalid = ['', 'not-a-url', 'http://backend.example.test/private', 'ftp://backend.example.test/private',
    'https://user:password@backend.example.test/private', 'https://@backend.example.test/private',
    BACKEND + '?', BACKEND + '?secret=fixture', BACKEND + '#', BACKEND + '#fragment', BACKEND + '/',
    ' ' + BACKEND, 'https://backend.example.test/white space', 'https://backend.example.test\\private',
    PUBLIC + '/private', 'https://COMPANY.MAPLAYER.TOP.:8443/private'];
  let calls = 0;
  const fetcher: EdgeFetch = async () => { calls++; return new Response(); };
  for (const origin of invalid) {
    const response = await createEdgeHandler(fetcher)(request('/api'), env({ OWNER_BACKEND_ORIGIN: origin }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'unavailable', message: '云端接口尚未配置' } });
  }
  expect((await createEdgeHandler(fetcher)(new Request('https://other-edge.example.test/api'), env({
    OWNER_BACKEND_ORIGIN: 'https://other-edge.example.test/private',
  }))).status).toBe(503);
  expect(calls).toBe(0);
});

test('缺失、过短或无法安全作为 HTTP 头的代理密钥被拒绝', async () => {
  let calls = 0;
  const handle = createEdgeHandler(async () => { calls++; return new Response(); });
  for (const key of ['', 'x'.repeat(31), ' '.repeat(32), 'x'.repeat(32) + '\n', 'x'.repeat(32) + '中文']) {
    expect((await handle(request('/api'), env({ OWNER_PROXY_KEY: key }))).status).toBe(503);
  }
  expect((await handle(request('/api'), env({ OWNER_PROXY_KEY: 'x'.repeat(32) }))).status).toBe(200);
  expect(calls).toBe(1);
});
