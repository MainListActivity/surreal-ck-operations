import { expect, test } from 'bun:test';
import { createOwnerServer, readServerEnvironment } from '../src/server.ts';
import { DAILY_CRON, MINUTE_CRON } from '../src/cron.ts';
import { runServerCron } from '../src/server-cron.ts';

const proxyKey = 'local-fixture-proxy-key-32-characters-only';
const publicOrigin = 'https://company.maplayer.top';
const source = {
  IDP_ISSUER: 'https://idp.example.test/company', IDP_JWKS_URL: 'https://idp.example.test/jwks',
  CONSOLE_CLIENT_ID: 'fixture-console', COMPANY_DB_URL: 'wss://db.example.test/rpc',
  COMPANY_NS: 'fixture', COMPANY_DB: 'fixture',
  OWNER_RELEASE_VERSION: '0.0.0-fixture', OWNER_RELEASE_SHA: 'a'.repeat(40),
};
const env = () => readServerEnvironment(source);
const headers = { 'x-company-proxy-key': proxyKey };
const timeout = async <T>(promise: Promise<T>, milliseconds = 2000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('fixture timeout')), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
};

test('云端环境仅从显式白名单构建，必要配置和代理配置在监听前校验', async () => {
  expect(() => readServerEnvironment({ ...source, COMPANY_DB_URL: '' })).toThrow('COMPANY_DB_URL');
  for (const root of [{ DEV_DB_ROOT_USER: 'root' }, { DEV_DB_ROOT_PASS: 'fixture-only' },
    { DEV_DB_ROOT_USER: 'root', DEV_DB_ROOT_PASS: 'fixture-only' }])
    expect(() => readServerEnvironment({ ...source, COMPANY_DB_URL: 'ws://127.0.0.1/rpc', ...root })).toThrow('DEV_DB_ROOT');
  const configured = readServerEnvironment({ ...source, UNRELATED_SECRET: 'fixture-secret', OWNER_PROXY_KEY: proxyKey });
  expect('UNRELATED_SECRET' in configured).toBe(false);
  expect('OWNER_PROXY_KEY' in configured).toBe(false);
  expect((await configured.ASSETS.fetch(new Request(publicOrigin))).status).toBe(404);
  for (const invalid of ['', 'short'])
    expect(() => createOwnerServer({ env: configured, publicOrigin, proxyKey: invalid, port: 0 })).toThrow('OWNER_PROXY_KEY');
  for (const invalid of ['http://company.maplayer.top', publicOrigin + '/path', 'https://name:pass@company.maplayer.top'])
    expect(() => createOwnerServer({ env: configured, publicOrigin: invalid, proxyKey, port: 0 })).toThrow('OWNER_PUBLIC_ORIGIN');
});

test('真实 HTTP：健康检查只有发布状态，非法路径及错误代理密钥不会调用业务', async () => {
  let calls = 0;
  const backend = createOwnerServer({ env: env(), publicOrigin, proxyKey, port: 0,
    fetch: () => { calls++; return new Response('unexpected'); } });
  try {
    expect(backend.server.hostname).toBe('127.0.0.1');
    const health = await fetch(new URL('/healthz', backend.server.url));
    expect(await health.json()).toEqual({ ok: true, ready: true, version: source.OWNER_RELEASE_VERSION, sha: source.OWNER_RELEASE_SHA });
    for (const path of ['/', '/api-other', '/cron'])
      expect((await fetch(new URL(path, backend.server.url))).status).toBe(404);
    for (const key of [undefined, '', proxyKey.slice(1), proxyKey.slice(0, -1) + 'x']) {
      const response = await fetch(new URL('/api/check', backend.server.url), {
        method: 'POST', body: 'fixture body must not reach business',
        headers: key === undefined ? {} : { 'x-company-proxy-key': key },
      });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(proxyKey);
      expect(response.headers.get('x-company-proxy-key')).toBeNull();
    }
    expect(calls).toBe(0);
  } finally { await backend.stop(); }
});

test('真实 HTTP：固定公网 URL，保留登录与 Origin，内部密钥和伪造转发头不进入业务', async () => {
  const backend = createOwnerServer({ env: env(), publicOrigin, proxyKey, port: 0,
    fetch: async request => {
      const received: Record<string, string> = {};
      request.headers.forEach((value, name) => { received[name] = value; });
      return Response.json({ url: request.url, headers: received, body: await request.text() });
    } });
  try {
    const response = await fetch(new URL('/api/check?next=%2Fproject&x=1', backend.server.url), {
      method: 'POST', body: 'request stays intact', headers: {
        ...headers, authorization: 'Bearer local-fixture', origin: publicOrigin, host: 'spoofed.example.test',
        forwarded: 'for=203.0.113.9;host=spoofed.example.test;proto=http',
        'x-forwarded-host': 'spoofed.example.test', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'http',
        'cf-connecting-ip': '203.0.113.9', 'x-real-ip': '203.0.113.9', 'true-client-ip': '203.0.113.9',
        'x-company-client-ip': '198.51.100.7',
      },
    });
    const value = await response.json();
    expect(value.url).toBe(publicOrigin + '/api/check?next=%2Fproject&x=1');
    expect(value.body).toBe('request stays intact');
    expect(value.headers.authorization).toBe('Bearer local-fixture');
    expect(value.headers.origin).toBe(publicOrigin);
    expect(value.headers['cf-connecting-ip']).toBe('198.51.100.7');
    for (const name of ['host', 'forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto',
      'x-real-ip', 'true-client-ip', 'x-company-proxy-key', 'x-company-client-ip']) expect(value.headers[name]).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain(proxyKey);
    const unknown = await fetch(new URL('/api/check', backend.server.url), { headers: {
      ...headers, 'x-company-client-ip': 'unknown', 'cf-connecting-ip': '203.0.113.9',
    } });
    expect((await unknown.json()).headers['cf-connecting-ip']).toBeUndefined();
  } finally { await backend.stop(); }
});

test('真实 Hono 业务仍校验登录及同源；代理密钥不能替代老板身份', async () => {
  const backend = createOwnerServer({ env: env(), publicOrigin, proxyKey, port: 0 });
  try {
    for (const path of ['/api/me', '/api/dashboard', '/api/events']) {
      const response = await fetch(new URL(path, backend.server.url), { headers });
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('unauthorized');
    }
    const forged = await fetch(new URL('/api/cmd', backend.server.url), {
      method: 'POST', body: '{}', headers: { ...headers, origin: 'https://spoofed.example.test', 'x-forwarded-host': 'spoofed.example.test' },
    });
    expect(forged.status).toBe(403);
    const sameOrigin = await fetch(new URL('/api/cmd', backend.server.url), { method: 'POST', body: '{}', headers: { ...headers, origin: publicOrigin } });
    expect(sameOrigin.status).toBe(401);
    expect((await fetch(new URL('/api/cron', backend.server.url), { headers })).status).toBe(404);
  } finally { await backend.stop(); }
});

test('异常响应不泄露业务异常或代理密钥', async () => {
  const backend = createOwnerServer({ env: env(), publicOrigin, proxyKey, port: 0,
    fetch: () => { throw Error(proxyKey); } });
  try {
    const response = await fetch(new URL('/api/check', backend.server.url), { headers });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  } finally { await backend.stop(); }
});

test('真实 HTTP SSE：先收到首块，静默超过 Bun 默认 10 秒仍存活；客户端断开取消源并传递 abort', async () => {
  let resolveCanceled!: () => void, resolveAborted!: () => void;
  const canceled = new Promise<void>(resolve => { resolveCanceled = resolve; });
  const aborted = new Promise<void>(resolve => { resolveAborted = resolve; });
  const encoder = new TextEncoder();
  const backend = createOwnerServer({ env: env(), publicOrigin, proxyKey, port: 0, idleTimeout: 1,
    fetch(request) {
      request.signal.addEventListener('abort', resolveAborted, { once: true });
      let later: ReturnType<typeof setTimeout>;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: ready\ndata: first\n\n'));
          later = setTimeout(() => controller.enqueue(encoder.encode('event: heartbeat\ndata: later\n\n')), 11_200);
        },
        cancel() { clearTimeout(later); resolveCanceled(); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const abort = new AbortController();
  try {
    const response = await fetch(new URL('/api/events', backend.server.url), { headers, signal: abort.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await timeout(reader.read())).value)).toContain('first');
    expect(new TextDecoder().decode((await timeout(reader.read(), 13_000)).value)).toContain('later');
    abort.abort();
    await timeout(Promise.all([canceled, aborted]));
  } finally { abort.abort(); await backend.stop(); }
}, 20_000);

test('真实 HTTP SSE：有界停机结束仍打开的流，并释放源', async () => {
  let resolveCanceled!: () => void;
  const canceled = new Promise<void>(resolve => { resolveCanceled = resolve; });
  const backend = createOwnerServer({ env: env(), publicOrigin, proxyKey, port: 0, shutdownGraceMs: 40,
    fetch: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: open\n\n')); },
      cancel() { resolveCanceled(); },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const abort = new AbortController();
  try {
    const response = await fetch(new URL('/api/events', backend.server.url), { headers, signal: abort.signal });
    await response.body!.getReader().read();
    await timeout(backend.stop(), 1500);
    await timeout(canceled);
    await backend.stop();
  } finally { abort.abort(); await backend.stop(); }
});

test('停机窗口允许在途普通请求完成，同时拒绝新的业务工作', async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const allowedToFinish = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const backend = createOwnerServer({ env: env(), publicOrigin, proxyKey, port: 0, shutdownGraceMs: 500,
    fetch: async () => { calls++; entered(); await allowedToFinish; return new Response('finished'); } });
  try {
    const current = fetch(new URL('/api/current', backend.server.url), { headers });
    await started;
    const stopping = backend.stop();
    const rejected = await fetch(new URL('/api/next', backend.server.url), { headers });
    expect(rejected.status).toBe(503);
    expect(calls).toBe(1);
    finish();
    expect(await (await current).text()).toBe('finished');
    await timeout(stopping, 1500);
  } finally { finish(); await backend.stop(); }
});

test('仅允许两个单次 cron，失败保持拒绝；不启动 HTTP 或定时器', async () => {
  const calls: string[] = [];
  for (const cron of [MINUTE_CRON, DAILY_CRON]) {
    expect(await runServerCron(cron, env(), async (config, sessions, selected) => {
      expect(config.db.namespace).toBe('fixture');
      expect(typeof sessions.automation).toBe('function');
      calls.push(selected); return { completed: true };
    })).toEqual({ completed: true });
  }
  await expect(runServerCron('unsupported', env(), async () => { throw Error('must not be called'); })).rejects.toThrow('仅支持');
  await expect(runServerCron(MINUTE_CRON, env(), async () => { throw Error('fixture failure'); })).rejects.toThrow('fixture failure');
  expect(calls).toEqual([MINUTE_CRON, DAILY_CRON]);
  const cli = Bun.spawn([process.execPath, '--no-env-file', 'owner-end/src/server-cron.ts', 'unsupported'], {
    cwd: new URL('../..', import.meta.url).pathname, env: { ...source, PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
  });
  expect(await cli.exited).not.toBe(0);
  expect(await new Response(cli.stdout).text()).toBe('');
  expect(await new Response(cli.stderr).text()).toBe('owner API cron 执行失败\n');
});
